use std::path::Path;

fn main() {
    // 平台专属配置由 tauri_build 在编译期内嵌，cargo 默认不跟踪这些文件：
    // 只改 tauri.windows.conf.json 时 build.rs 不会重跑，二进制里仍是旧配置。
    // 这里显式声明（仅声明存在的文件：cargo 对不存在的路径会判定为每次都变更）。
    for file in [
        "tauri.windows.conf.json",
        "tauri.macos.conf.json",
        "tauri.linux.conf.json",
    ] {
        if Path::new(file).exists() {
            println!("cargo:rerun-if-changed={file}");
        }
    }
    tauri_build::build()
}
