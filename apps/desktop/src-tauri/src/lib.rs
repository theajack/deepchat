use std::net::TcpStream;
use std::path::{Path, PathBuf};
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

/// 打包进 app 的 dsh 运行时目录（Contents/Resources/dsh）。
///
/// 布局由 `scripts/build-desktop-runtime.sh` 产出：
/// ```text
/// resources/dsh/
/// ├── node/bin/node            内置 Node，用户机器上无需自己装 Node
/// └── runtime/                 dsh CLI + chat 插件的生产依赖闭包
/// ```
/// dev（未打包）时 `resource_dir()` 不存在，退回仓库内的同名目录，
/// 这样 `pnpm tauri dev` 与打包产物走的是同一条路径。
/// 去掉 Windows 的 `\\?\` verbatim 前缀。
///
/// Tauri 在 Windows 上给出的资源目录是 `\\?\D:\...` 形式，Node 无法解析它
/// （会把前缀后的内容解析错，最终去 lstat `D:`），交给子进程前必须去掉。
fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path.to_path_buf(),
    }
}

/// 内置 Node 可执行文件名：Windows 官方发行版带 `.exe`，其它平台无扩展名。
fn bundled_node_name() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn resolve_bundled_dsh_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(dir) = app.path().resource_dir() {
        // Tauri 把 `bundle.resources` 的条目放在 <resource_dir>/resources 下，
        // 两种布局都认一遍，避免以后调整 resources 配置就找不到运行时。
        for candidate in [dir.join("dsh"), dir.join("resources").join("dsh")] {
            if candidate.join("node").join("bin").join(bundled_node_name()).exists() {
                return Some(candidate);
            }
        }
    }
    let root = resolve_repo_root()?;
    let candidate = root.join("apps").join("desktop").join("src-tauri").join("resources").join("dsh");
    if candidate.join("node").join("bin").join(bundled_node_name()).exists() {
        return Some(candidate);
    }
    None
}

/// 打包运行时的启动三元组（program / args / cwd）。
fn resolve_bundled_command(app: &AppHandle) -> Option<(String, Vec<String>, PathBuf, PathBuf)> {
    let dsh_dir = resolve_bundled_dsh_dir(app)?;
    let node = without_verbatim_prefix(&dsh_dir.join("node").join("bin").join(bundled_node_name()));
    let bin = without_verbatim_prefix(
        &dsh_dir
            .join("runtime")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
    );
    if !node.exists() || !bin.exists() {
        return None;
    }
    // 运行时目录同时作为 profile 依赖的解析根（见 ensure_dsh_home）
    let runtime_dir = without_verbatim_prefix(&dsh_dir.join("runtime"));
    Some((
        node.to_string_lossy().to_string(),
        vec![bin.to_string_lossy().to_string(), "--profile".into(), "chat-agent".into()],
        without_verbatim_prefix(&dsh_dir),
        runtime_dir,
    ))
}

/// 用户数据目录：`~/Library/Application Support/<identifier>/dsh-home`
///
/// 打包后 app bundle 是只读的（且会被 Gatekeeper 移形），DSH_HOME 必须落在
/// 可写目录；dev 模式继续用仓库内的 .dsh-home，保持与既有开发流程一致。
fn resolve_dsh_home(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().app_data_dir() {
        return dir.join("dsh-home");
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join(".dsh-home")
}

/// chat-agent profile 的清单：声明 profile 由哪些 bundle 层组成。
const PROFILE_MANIFEST: &str = r#"{
  "name": "dsh-profile-chat-agent",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-chat-agent"
      ]
    }
  }
}
"#;

/// 首次运行（或运行时被搬到别处后）准备好 DSH_HOME 与 chat-agent profile。
///
/// dsh 解析 profile bundle 时，安装锚点（内置 CLI）只认 `@deepseek-ai/dsh-base`，
/// chat 插件要靠 profile 目录自己的 node_modules 解析——因此这里把 profile 的
/// node_modules 软链到打包出来的运行时 node_modules。软链每次启动都重建：
/// app 被移动到别的目录后旧链接会失效，重建比"一次性创建 + 之后 404"更稳。
fn ensure_dsh_home(dsh_home: &Path, runtime_dir: &Path) -> std::io::Result<()> {
    let profile = dsh_home.join("profiles").join("chat-agent");
    std::fs::create_dir_all(&profile)?;

    let manifest = profile.join("package.json");
    if !manifest.exists() {
        std::fs::write(&manifest, PROFILE_MANIFEST)?;
    }
    let patch = profile.join("cordis.patch.yml");
    if !patch.exists() {
        std::fs::write(&patch, "[]\n")?;
    }

    let link = profile.join("node_modules");
    let target = runtime_dir.join("node_modules");
    let needs_link = std::fs::read_link(&link).map(|p| p != target).unwrap_or(true);
    if needs_link {
        // 已存在则先移除（软链或普通目录都清掉），再重新指向当前运行时
        match std::fs::symlink_metadata(&link) {
            Ok(_) => std::fs::remove_file(&link).or_else(|_| std::fs::remove_dir_all(&link))?,
            Err(_) => {}
        }
        link_runtime_modules(&link, &target)?;
    }
    Ok(())
}

/// 把 profile 的 node_modules 指向打包运行时的依赖闭包。
///
/// 打包产物在 DSH_HOME 下解析 chat 插件，必须指向运行时的 node_modules：
/// unix 建目录软链，Windows 建 junction（符号链接要管理员权限，junction 不要）。
/// 失败时返回 Err，由调用方打印并继续——仓库内 CLI 不依赖这个链接解析依赖。
fn link_runtime_modules(link: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)?;
    }
    #[cfg(windows)]
    {
        // 目录符号链接需要开发者模式或管理员权限，junction（mklink /J）对普通用户可用。
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let link_text = link.to_string_lossy().into_owned();
        let target_text = target.to_string_lossy().into_owned();
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J", link_text.as_str(), target_text.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .status()?;
        if !status.success() {
            return Err(std::io::Error::other("mklink /J 创建 node_modules 联接失败"));
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        return Err(std::io::Error::other(
            "当前平台不支持创建 node_modules 软链",
        ));
    }
    Ok(())
}

/// dev 兜底：仓库内已构建的 dsh CLI（`node apps/cli/lib/bin.js`）
fn resolve_dev_command() -> Option<(String, Vec<String>, PathBuf, Option<PathBuf>)> {
    let root = resolve_repo_root()?;
    let bin = root.join("apps").join("cli").join("lib").join("bin.js");
    if !bin.exists() {
        return None;
    }
    Some((
        "node".to_string(),
        vec![bin.to_string_lossy().to_string(), "--profile".into(), "chat-agent".into()],
        root,
        None,
    ))
}

/// 解析 dsh 启动方式：
/// 1. DEEPCHAT_DSH_CMD 环境变量（完整命令，如 "node /path/bin.js"）
/// 2. 打包运行时：Contents/Resources 下的内置 node + dsh CLI（用户无需装 Node）
/// 3. dev 兜底：仓库根目录 node apps/cli/lib/bin.js --profile chat-agent
///
/// dev（debug 构建）优先走仓库，数据照旧落在 repo/.dsh-home——运行时
/// staging 目录在打包前也会存在，若不区分，开发时反而会用上打包产物。
fn resolve_dsh_command(app: &AppHandle) -> Option<(String, Vec<String>, PathBuf, Option<PathBuf>)> {
    // 1. 显式环境变量（空格分隔完整命令）
    if let Ok(cmd) = std::env::var("DEEPCHAT_DSH_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from);
        let program = parts.next()?;
        let args: Vec<String> = parts.chain(["--profile".into(), "chat-agent".into()]).collect();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        return Some((program, args, cwd, None));
    }

    if cfg!(debug_assertions) {
        if let Some(dev) = resolve_dev_command() {
            return Some(dev);
        }
    }
    // 2. 打包运行时：内置 node + 部署好的依赖闭包
    if let Some((program, args, cwd, runtime_dir)) = resolve_bundled_command(app) {
        return Some((program, args, cwd, Some(runtime_dir)));
    }
    // 3. dev 兜底
    resolve_dev_command()
}

fn spawn_dsh(app: &AppHandle) -> std::io::Result<Arc<Mutex<Child>>> {
    let (program, args, cwd, runtime_dir) = resolve_dsh_command(app)
        .ok_or_else(|| std::io::Error::other("无法定位 dsh（先在仓库根目录执行 pnpm run build）"))?;

    // DSH_HOME：打包后用应用数据目录（bundle 只读），dev 用仓库内 .dsh-home
    let dsh_home = match &runtime_dir {
        Some(_) => resolve_dsh_home(app),
        None => cwd.join(".dsh-home"),
    };
    if let Some(runtime) = &runtime_dir {
        if let Err(e) = ensure_dsh_home(&dsh_home, runtime) {
            eprintln!("DeepChat: 准备 DSH_HOME 失败: {e}");
        }
    }

    let mut command = Command::new(&program);
    command
        .args(&args)
        .current_dir(&dsh_home)
        .env("DSH_HOME", &dsh_home)
        .stdin(Stdio::null());
    if cfg!(debug_assertions) {
        // dev：继承终端，宿主日志直接打在启动它的控制台上。
        command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
    } else {
        // 打包产物是 GUI 子系统进程，没有可继承的控制台：把宿主输出落到
        // DSH_HOME/logs/dsh-host.log，否则启动失败时无从排查。
        let log_dir = dsh_home.join("logs");
        std::fs::create_dir_all(&log_dir)?;
        let log = std::fs::File::create(log_dir.join("dsh-host.log"))?;
        let log_err = log.try_clone()?;
        command.stdout(log).stderr(log_err);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        // node.exe 是控制台程序：被 GUI 进程拉起时系统会为它新建一个控制台，
        // 运行时会闪出黑框。打包构建统一隐藏；dev 保留继承的终端便于调试。
        if !cfg!(debug_assertions) {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }

    let mut child = command.spawn()?;

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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        // 原生文件/目录选择对话框（好友工作目录选择）
        .plugin(tauri_plugin_dialog::init())
        .on_page_load(on_page_load)
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    // setup 运行在主线程，直接调用即可安全操作红绿灯
                    setup_traffic_lights(&window);
                }
            }

            // Windows 走自绘标题栏：最小化 / 最大化 / 关闭由 ChatHeader 内的
            // WindowControls 渲染，这里关掉系统装饰，避免原生标题栏与自绘按钮重复。
            // macOS 保留系统红绿灯，编译期即排除。
            #[cfg(target_os = "windows")]
            {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(false) {
                        eprintln!("[DeepChat] 关闭窗口装饰失败: {e}");
                    }
                }
            }

            #[cfg(windows)]
            {
                // Windows 不渲染原生标题栏，最小化/最大化/关闭由前端 TitleBar 自绘。
                // tauri.windows.conf.json 里的 decorations: false 是创建窗口时的开关，
                // 这里再兜一次：配置因缓存未重新内嵌时，也保证启动后标题栏被移除。
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(false) {
                        eprintln!("[DeepChat] 关闭原生标题栏失败: {e}");
                    }
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    // 退出时收掉 dsh 宿主：否则关闭窗口后 node 仍驻留并占着 3180 端口，
    // 下次启动会因端口被占用而拿不到后端。
    app.run(|handle, event| {
        if !matches!(event, tauri::RunEvent::Exit) {
            return;
        }
        let Some(state) = handle.try_state::<DshState>() else {
            return;
        };
        let Ok(guard) = state.child.lock() else {
            return;
        };
        if let Some(child) = guard.as_ref() {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        }
    });
}
