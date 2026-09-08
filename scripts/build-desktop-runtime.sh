#!/usr/bin/env bash
#
# 准备 DeepChat 桌面端的 dsh 运行时，产出：
#
#   apps/desktop/src-tauri/resources/dsh/
#   ├── node/bin/node                内置 Node 二进制（免用户安装 Node）
#   └── runtime/                     dsh CLI + chat 插件的生产依赖闭包
#
# 由 `pnpm tauri build` 通过 beforeBuildCommand 调用；也可单独执行。
# 产物目录已被 git 忽略，且可被本脚本安全重跑（旧产物移到 /tmp，不直接删除）。
#
# 打进 app 的依赖闭包由 `apps/desktop-runtime/package.json` 声明（dsh CLI +
# chat 插件及其传递的 workspace 依赖，共约 200 个包）。新增插件后如果启动时报
# `Cannot find package '@deepseek-ai/...'`，把缺的包加进这个文件再重跑本脚本。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="$REPO_ROOT/apps/desktop/src-tauri/resources/dsh"
RUNTIME_DIR="$STAGE/runtime"
NODE_DIR="$STAGE/node"
SKILL_DIR="$STAGE/skills"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) NODE_ARCH="arm64" ;;
  x86_64)        NODE_ARCH="x64" ;;
  *) echo "build-desktop-runtime: unsupported arch $ARCH" >&2; exit 1 ;;
esac
case "$(uname -s)" in
  Darwin) NODE_OS="darwin" ;;
  Linux)  NODE_OS="linux" ;;
  *) echo "build-desktop-runtime: unsupported os $(uname -s)" >&2; exit 1 ;;
esac

# 内置 Node 版本：默认取当前最新的 v22 LTS，可用 NODE_VERSION 覆盖。
if [ -z "${NODE_VERSION:-}" ]; then
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | node -e '
    let raw = ""
    process.stdin.on("data", (c) => { raw += c })
    process.stdin.on("end", () => {
      const v = JSON.parse(raw).filter((r) => r.lts && r.version.startsWith("v22")).map((r) => r.version)[0]
      if (!v) { console.error("no v22 LTS found"); process.exit(1) }
      console.log(v)
    })
  ')"
fi

echo "==> node: $NODE_VERSION ($NODE_OS-$NODE_ARCH)"

if [ ! -x "$NODE_DIR/bin/node" ]; then
  # 旧产物移出 resources 树（不删除，避免误伤，也省一次上万文件的 rm）
  if [ -e "$NODE_DIR" ]; then
    mv "$NODE_DIR" "$(mktemp -d /tmp/deepchat-node-old.XXXXXX)/node"
  fi
  mkdir -p "$NODE_DIR"
  TMPDIR_NODE="$(mktemp -d)"
  TARBALL="$TMPDIR_NODE/node.tar.gz"
  echo "==> downloading node $NODE_VERSION"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-$NODE_OS-$NODE_ARCH.tar.gz" -o "$TARBALL"
  # 只要 node 二进制本身：官方构建里它是自包含的可执行文件，
  # npm / corepack / include / share 都不参与运行，解出来即可省下约 60MB。
  tar -xzf "$TARBALL" -C "$NODE_DIR" --strip-components=1 "*/bin/node"
  rm -f "$TARBALL"
  rmdir "$TMPDIR_NODE"
else
  echo "==> node already staged"
fi

echo "==> deploying dsh runtime closure"
# 旧产物是上万个 pnpm 硬链接文件，递归删既慢又容易触发批量删除保护，
# 这里直接整体移出 resources 树，再由 pnpm deploy 建全新的目录。
if [ -e "$RUNTIME_DIR" ]; then
  mv "$RUNTIME_DIR" "$(mktemp -d /tmp/deepchat-runtime-old.XXXXXX)/runtime"
fi
cd "$REPO_ROOT"
# --legacy：本仓库的 workspace 依赖是符号链接（未开启 inject-workspace-packages），
# 非 legacy 模式会拒绝部署；legacy 模式会把 workspace 包实体拷进 .pnpm，
# 因此产物目录不依赖仓库、可整体打进 app bundle。
# --legacy：本仓库的 workspace 依赖是符号链接（未开启 inject-workspace-packages），
# 非 legacy 模式会拒绝部署。
# node-linker=hoisted：默认的 pnpm 布局里 node_modules 顶层全是符号链接，
# 而 Tauri 拷贝 resources 时会跳过符号链接，产物会是个空壳，所以这里用
# 提升（hoisted）布局，让每个包都是真实目录。
pnpm --filter deepchat-runtime deploy --prod --legacy --config.node-linker=hoisted "$RUNTIME_DIR"

# hoisted 之后仍可能有少量指向仓库源码的软链（vendor 下的 workspace 包）。
# 这些链接脱离仓库就失效，逐个实体化：先删链接（单文件，非批量），再拷内容。
# 实体化后，被拷进来的目录里可能又带出新的软链（比如 vendor 源码自带的
# node_modules），所以反复扫到没有可处理的链接为止。
node -e '
const fs = require("fs"), path = require("path")
const root = process.argv[1]
const isBin = p => p.includes(`${path.sep}.bin${path.sep}`)
let total = 0
for (let pass = 0; pass < 10; pass++) {
  const links = []
  ;(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) links.push(p)
      else if (entry.isDirectory()) walk(p)
    }
  })(root)
  const pending = links.filter(p => !isBin(p))
  if (pending.length === 0) break
  for (const link of pending) {
    let target
    try { target = fs.realpathSync(link) } catch { continue }  // 悬空链接：忽略
    fs.rmSync(link)
    fs.cpSync(target, link, { recursive: true, dereference: true })
    total++
  }
}
console.log(`==> materialized symlinks: ${total}`)
' "$RUNTIME_DIR/node_modules"

# 内置技能：仓库 .agents/skills 在 dev 模式下靠「cwd=仓库被当作项目根」被扫到，
# 打包后 cwd 是 DSH_HOME，全新机器上没有任何技能来源。随包分发一份，宿主通过
# DSH_BUNDLED_SKILL_DIR 注册（source=bundled，受信）。
if [ -d "$REPO_ROOT/.agents/skills" ]; then
  rm -rf "$SKILL_DIR"
  mkdir -p "$SKILL_DIR"
  cp -R "$REPO_ROOT/.agents/skills/." "$SKILL_DIR/"
  echo "==> bundled skills: $(ls "$SKILL_DIR" | wc -l | tr -d ' ') entries"
else
  echo "==> no .agents/skills in repo, skipping bundled skills"
fi

echo "==> runtime staged:"
du -sh "$NODE_DIR" "$RUNTIME_DIR" "$SKILL_DIR"
