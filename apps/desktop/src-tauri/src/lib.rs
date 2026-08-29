use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "macos")]
fn setup_traffic_lights(window: &tauri::WebviewWindow) {
    use objc2::exception::catch;
    use objc2::msg_send;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2::runtime::AnyObject;

    // 仅持有裸指针（UnwindSafe），在闭包内部再转回引用
    let ns_window_ptr = window.ns_window().expect("ns_window");

    let result = unsafe {
        catch(|| {
            let ns_window: &AnyObject = &*(ns_window_ptr as *const AnyObject);

            // 获取三个按钮
            let close_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0];
            let mini_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 1];
            let zoom_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 2];

            let btn_size = 12.0_f64;
            let gap = 5.0_f64;
            let start_x = 8.0_f64;
            let y = 12.0_f64;

            for (i, btn) in [close_btn, mini_btn, zoom_btn].iter().enumerate() {
                if btn.is_null() {
                    continue;
                }

                let x = start_x + (i as f64) * (btn_size + gap);
                let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(btn_size, btn_size));
                let _: () = msg_send![*btn, setFrame: frame];
            }
        })
    };
    if let Err(e) = result {
        eprintln!("setup_traffic_lights failed: {:?}", e);
    }
}

/// dsh 宿主子进程句柄（`dsh --profile chat-agent`）
struct DshState {
    #[allow(dead_code)]
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

/// dsh host 监听地址（与 chat-agent bundle 的 webserver 配置一致）
const DSH_HOST: &str = "127.0.0.1";
const DSH_PORT: u16 = 3180;

/// 定位 dsh 仓库根目录：从当前目录向上寻找 apps/desktop
fn resolve_repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    loop {
        if dir.join("apps").join("desktop").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            return None;
        }
    }
}

/// 解析 dsh 启动方式：
/// 1. DEEPCHAT_DSH_CMD 环境变量（完整命令，如 "node /path/bin.js"）
/// 2. 打包后：app bundle 内嵌的 dsh（TODO：随产物分发）
/// 3. dev 兜底：仓库根目录 node apps/cli/lib/bin.js --profile chat-agent
fn resolve_dsh_command() -> Option<(String, Vec<String>, PathBuf)> {
    // 1. 显式环境变量（空格分隔完整命令）
    if let Ok(cmd) = std::env::var("DEEPCHAT_DSH_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from);
        let program = parts.next()?;
        let args: Vec<String> = parts.chain(["--profile".into(), "chat-agent".into()]).collect();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return Some((program, args, cwd));
    }

    // 2. 打包后：bundle 内嵌二进制（后续里程碑接入 sidecar）

    // 3. dev 模式：跑仓库内已构建的 dsh CLI
    let root = resolve_repo_root()?;
    let bin = root.join("apps").join("cli").join("lib").join("bin.js");
    if !bin.exists() {
        return None;
    }
    Some((
        "node".to_string(),
        vec![bin.to_string_lossy().to_string(), "--profile".into(), "chat-agent".into()],
        root,
    ))
}

fn spawn_dsh(app: &AppHandle) -> std::io::Result<Arc<Mutex<Child>>> {
    let (program, args, cwd) = resolve_dsh_command()
        .ok_or_else(|| std::io::Error::other("无法定位 dsh（先在仓库根目录执行 pnpm run build）"))?;

    let mut child = Command::new(&program)
        .args(&args)
        .current_dir(&cwd)
        // 仓库内 DSH_HOME：profile/会话/存储都落在 repo/.dsh-home（已 gitignore）
        .env("DSH_HOME", cwd.join(".dsh-home"))
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()?;

    let child = Arc::new(Mutex::new(child));

    // 子进程退出时通知前端（共享所有权轮询 try_wait）
    let handle = app.clone();
    let watcher = Arc::clone(&child);
    std::thread::spawn(move || loop {
        let exited = watcher
            .try_lock()
            .map(|mut guard| guard.try_wait().map(|status| status.is_some()).unwrap_or(true))
            .unwrap_or(false);
        if exited {
            let _ = handle.emit("dsh.exited", json!(null));
            return;
        }
        std::thread::sleep(Duration::from_millis(500));
    });

    // 就绪探测：轮询 TCP 端口，成功后通知前端
    let ready = app.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if TcpStream::connect((DSH_HOST, DSH_PORT)).is_ok() {
                let _ = ready.emit("dsh.ready", json!({ "url": format!("http://{DSH_HOST}:{DSH_PORT}") }));
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        let _ = ready.emit("dsh.timeout", json!(null));
    });

    Ok(child)
}

/// 查询 dsh host 是否就绪（前端启动时轮询用）
#[tauri::command]
fn dsh_ready() -> bool {
    TcpStream::connect((DSH_HOST, DSH_PORT)).is_ok()
}

// ============ 浏览器 Tab 历史与导航控制 ============
//
// 每个 Tab 对应一个 Tauri Webview。所有导航（back / forward / reload / navigate）
// 均由 Rust 侧的 command 驱动，通过 webview.eval() 注入 JS 实现 history 控制，
// 并通过初始化脚本 + postMessage 上报导航事件给前端浏览器窗口。

fn find_webview(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    app.webviews()
        .into_iter()
        .find(|(l, _)| l == label)
        .map(|(_, wv)| wv)
        .ok_or_else(|| format!("webview 不存在: {label}"))
}

/// 后退（history.back）
#[tauri::command]
fn browser_back(app: AppHandle, label: String) -> Result<(), String> {
    let wv = find_webview(&app, &label)?;
    wv.eval("window.history.back()").map_err(|e| e.to_string())
}

/// 前进（history.forward）
#[tauri::command]
fn browser_forward(app: AppHandle, label: String) -> Result<(), String> {
    let wv = find_webview(&app, &label)?;
    wv.eval("window.history.forward()").map_err(|e| e.to_string())
}

/// 刷新当前页面
/// 注：wry 的 webview.reload() 在部分场景不生效，改用 location.reload()
#[tauri::command]
fn browser_reload(app: AppHandle, label: String) -> Result<(), String> {
    let wv = find_webview(&app, &label)?;
    wv.eval("location.reload()").map_err(|e| e.to_string())
}

/// 导航到指定 URL（用于地址栏跳转，会追加到 history）
#[tauri::command]
fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let wv = find_webview(&app, &label)?;
    let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

/// 返回当前 URL
#[tauri::command]
fn browser_current_url(app: AppHandle, label: String) -> Result<String, String> {
    let wv = find_webview(&app, &label)?;
    wv.url().map(|u| u.to_string()).map_err(|e| e.to_string())
}

/// 通过 JS 获取当前页面标题（已废弃：标题改由 on_document_title_changed 原生上报）
#[allow(dead_code)]
#[tauri::command]
fn browser_get_title(app: AppHandle, label: String) -> Result<(), String> {
    let wv = find_webview(&app, &label)?;
    wv.eval("void 0").map_err(|e| e.to_string())
}

/// 打开当前窗口的开发者工具（Web Inspector）
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// 创建浏览器 tab webview（由前端调用，替代 JS 侧 new Webview）。
/// 在 Rust 侧创建才能挂载 on_new_window / on_document_title_changed 等原生钩子：
/// - 新窗口请求（target=_blank / window.open）→ 通知 browser 窗口开新标签，并拒绝原生开窗
/// - 标题变化 → 上报 browser 窗口
#[tauri::command]
fn browser_create_tab(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    use tauri::webview::{WebviewBuilder, NewWindowResponse};
    use tauri::WebviewUrl;

    let window = app
        .get_window("browser")
        .ok_or_else(|| "browser 窗口不存在".to_string())?;

    let parsed: url::Url = url
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let emit_handle = app.clone();
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .on_new_window(move |url, _features| {
            // 页面请求新窗口（_blank / window.open）→ 转为浏览器新标签
            let _ = emit_handle.emit_to(
                "browser",
                "browser:new-tab",
                json!({ "url": url.to_string() }),
            );
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |webview, title| {
            // 页面标题变化 → 上报 browser 窗口
            let _ = webview.emit_to(
                "browser",
                "browser:tab-state",
                json!({
                    "label": webview.label(),
                    "url": "",
                    "title": title,
                    "kind": "title",
                }),
            );
        });

    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(x, y),
            tauri::LogicalSize::new(width, height),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 全局页面加载钩子：对所有 webview 生效。
/// 仅处理浏览器 tab webview（label 以 browser-tab- 开头）：
/// Started/Finished → 向 browser 窗口上报 URL 与加载状态
/// （不注入任何页面脚本——外部页面的 IPC 会被远程 origin 拦截，注入方案不可靠）
fn on_page_load(webview: &tauri::Webview, payload: &tauri::webview::PageLoadPayload<'_>) {
    use tauri::webview::PageLoadEvent;

    let label = webview.label().to_string();
    if !label.starts_with("browser-tab-") {
        return;
    }

    let url = payload.url().to_string();
    let kind = match payload.event() {
        PageLoadEvent::Started => "started",
        PageLoadEvent::Finished => "load",
    };

    // 定向上报到 browser 窗口（URL / 加载状态）
    let _ = webview.emit_to(
        "browser",
        "browser:tab-state",
        json!({ "label": label, "url": url, "title": "", "kind": kind }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .on_page_load(on_page_load)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    // setup 运行在主线程，直接调用即可安全操作红绿灯
                    setup_traffic_lights(&window);
                }
            }

            match spawn_dsh(app.handle()) {
                Ok(child) => {
                    app.manage(DshState {
                        child: Mutex::new(Some(child)),
                    });
                    eprintln!("[DeepChat] dsh 宿主进程已启动（--profile chat-agent）");
                }
                Err(e) => {
                    eprintln!(
                        "[DeepChat] dsh 宿主进程启动失败（应用将继续运行但无后端功能）: {e}"
                    );
                    // 生产环境可能没有 node 或构建产物，不阻塞 UI 启动
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dsh_ready,
            open_devtools,
            browser_back,
            browser_forward,
            browser_reload,
            browser_navigate,
            browser_current_url,
            browser_get_title,
            browser_create_tab,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
