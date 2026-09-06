#!/usr/bin/env bash
#
# 打包 DeepChat 桌面端（产出 .app 与 .dmg）。
#
# 用法：
#   bash scripts/build-desktop.sh            # 从仓库任意位置执行
#
# 为什么不是直接 `pnpm tauri build`：
#   pnpm 11 运行命令前会校验依赖，必要时自己跑 `pnpm install --production`，
#   那会剪掉全部 devDependencies（vite / vue-tsc / @tauri-apps/cli），
#   打包还没开始就被打断。这个开关 pnpm 只认环境变量（.npmrc 无效），
#   所以在这里 export 掉再交给 tauri。
#
# 打包前会由 tauri.conf.json 的 beforeBuildCommand 依次执行：
#   pnpm build                           （前端：vue-tsc + vite）
#   scripts/build-desktop-runtime.sh     （内置 node + dsh 运行时）

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export pnpm_config_verify_deps_before_run=false

cd "$REPO_ROOT/apps/desktop"
exec pnpm tauri build "$@"
