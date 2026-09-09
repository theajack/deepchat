#!/usr/bin/env node
//
// 准备 DeepChat 桌面端的 dsh 运行时（跨平台入口，由 tauri 的 beforeBuildCommand 调用）。
//
// 产出：
//   apps/desktop/src-tauri/resources/dsh/
//   ├── node/bin/node[.exe]    内置 Node（免用户安装 Node）
//   └── runtime/               dsh CLI + chat 插件的生产依赖闭包
//
// Unix 分支直接复用既有的 build-desktop-runtime.sh（下载 node + pnpm deploy）；
// Windows 分支在这里实现同一套产物，因为打包机上不保证有 bash。

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const stage = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'resources', 'dsh')
const runtimeDir = join(stage, 'runtime')
const nodeDir = join(stage, 'node')

if (process.platform !== 'win32') {
  execFileSync('bash', [join(here, 'build-desktop-runtime.sh')], { cwd: repoRoot, stdio: 'inherit' })
  process.exit(0)
}

/** 取最新的 v22 LTS 版本号（可用 NODE_VERSION 覆盖）。 */
async function resolveNodeVersion() {
  if (process.env.NODE_VERSION !== undefined && process.env.NODE_VERSION !== '') return process.env.NODE_VERSION
  const releases = await (await fetch('https://nodejs.org/dist/index.json')).json()
  const match = releases.find((entry) => entry.lts && entry.version.startsWith('v22'))
  if (match === undefined) throw new Error('build-desktop-runtime: no v22 LTS found')
  return match.version
}

/** 下载内置 Node：Windows 官方发行版提供自包含的 node.exe，不需要 npm/include。 */
async function stageNode() {
  const nodeExe = join(nodeDir, 'bin', 'node.exe')
  if (existsSync(nodeExe)) {
    console.log('==> node already staged')
    return
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const version = await resolveNodeVersion()
  console.log(`==> node: ${version} (win-${arch})`)
  mkdirSync(join(nodeDir, 'bin'), { recursive: true })
  const response = await fetch(`https://nodejs.org/dist/${version}/win-${arch}/node.exe`)
  if (!response.ok) throw new Error(`build-desktop-runtime: node download failed: ${String(response.status)}`)
  writeFileSync(nodeExe, Buffer.from(await response.arrayBuffer()))
}

/**
 * 部署 dsh 依赖闭包。
 *
 * --legacy：本仓库的 workspace 依赖是符号链接，非 legacy 模式会拒绝部署。
 * node-linker=hoisted：默认 pnpm 布局顶层全是符号链接，而 Tauri 拷贝 resources
 * 时会跳过符号链接，产物会是个空壳。
 */
function deployRuntime() {
  // 幂等：完整部署过的运行时直接复用，避免每次打包重跑上万文件的 deploy。
  const cliEntry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(cliEntry)) {
    console.log('==> runtime already deployed (skipped)')
    return
  }
  console.log('==> deploying dsh runtime closure')
  if (existsSync(runtimeDir)) {
    // 旧产物（多为上次中断留下的半棵依赖树）整体移出 resources 树：
    // 同盘重命名到 target，既不参与打包，也免掉递归删上万个文件。
    const retired = join(repoRoot, 'apps', 'desktop', 'src-tauri', 'target', `deepchat-runtime-old-${Date.now()}`)
    try {
      mkdirSync(retired, { recursive: true })
      renameSync(runtimeDir, join(retired, 'runtime'))
    } catch (error) {
      throw new Error(
        `build-desktop-runtime: 旧运行时无法移出，请手动删除后重试：${runtimeDir}（${String(error)}）`,
      )
    }
  }
  execFileSync(
    'pnpm',
    ['--filter', 'deepchat-runtime', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', runtimeDir],
    { cwd: repoRoot, stdio: 'inherit', shell: true },
  )
}

/**
 * 实体化残留软链：hoisted 之后仍可能有指向仓库源码的链接，脱离仓库即失效。
 * 实体化后可能又带出新链接，所以反复扫到没有可处理的链接为止。
 */
function materializeSymlinks() {
  const root = join(runtimeDir, 'node_modules')
  const isBin = (path) => path.includes(`${sep}.bin${sep}`)
  let total = 0
  for (let pass = 0; pass < 10; pass += 1) {
    const links = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isSymbolicLink()) links.push(path)
        else if (entry.isDirectory()) walk(path)
      }
    }
    walk(root)
    const pending = links.filter((path) => !isBin(path))
    if (pending.length === 0) break
    for (const link of pending) {
      let target
      try {
        target = realpathSync(link)
      } catch {
        continue
      }
      unlinkSync(link)
      cpSync(target, link, { recursive: true, dereference: true })
      total += 1
    }
  }
  console.log(`==> materialized symlinks: ${String(total)}`)
}

/**
 * 内置技能随包分发：仓库 .agents/skills 在 dev 模式下靠「cwd=仓库被当作项目根」
 * 被扫到，打包后 cwd 是 DSH_HOME，全新机器上没有任何技能来源。随包分发一份，
 * 宿主通过 DSH_BUNDLED_SKILL_DIR 注册（source=bundled，受信）。
 * 与 build-desktop-runtime.sh 的同名逻辑保持一致。
 */
function stageSkills() {
  const skillDir = join(stage, 'skills')
  const source = join(repoRoot, '.agents', 'skills')
  if (!existsSync(source)) {
    console.log('==> no .agents/skills in repo, skipping bundled skills')
    return
  }
  if (existsSync(skillDir)) {
    // 旧产物移出 resources 树（同盘重命名到 target，不参与打包）
    const retired = join(
      repoRoot,
      'apps',
      'desktop',
      'src-tauri',
      'target',
      `deepchat-skills-old-${Date.now()}`,
    )
    mkdirSync(retired, { recursive: true })
    renameSync(skillDir, join(retired, 'skills'))
  }
  cpSync(source, skillDir, { recursive: true, dereference: true })
  console.log(`==> bundled skills: ${String(readdirSync(skillDir).length)} entries`)
}

await stageNode()
deployRuntime()
materializeSymlinks()
stageSkills()
console.log(`==> runtime staged at ${stage}`)
