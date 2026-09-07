#!/usr/bin/env pwsh
#
# 准备 DeepChat 桌面端的 dsh 运行时（Windows 版，对应 scripts/build-desktop-runtime.sh）。
# 产出：
#
#   apps/desktop/src-tauri/resources/dsh/
#   ├── node/bin/node.exe            内置 Node（免用户安装 Node）
#   └── runtime/                     dsh CLI + chat 插件的生产依赖闭包
#
# 由 `pnpm tauri build` 通过 tauri.windows.conf.json 的 beforeBuildCommand 调用；
# 也可单独执行：pwsh scripts/build-desktop-runtime.ps1

param(
  # 内置 Node 版本；默认取最新的 v22 LTS（与 bash 版一致）。
  [string]$NodeVersion
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Stage = Join-Path $RepoRoot 'apps/desktop/src-tauri/resources/dsh'
$RuntimeDir = Join-Path $Stage 'runtime'
$NodeDir = Join-Path $Stage 'node'
$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

if (-not $NodeVersion) {
  $releases = Invoke-RestMethod 'https://nodejs.org/dist/index.json'
  $NodeVersion = ($releases | Where-Object { $_.lts -and $_.version.StartsWith('v22') } | Select-Object -First 1).version
  if (-not $NodeVersion) { throw 'build-desktop-runtime: no v22 LTS found' }
}

Write-Host "==> node: $NodeVersion (win-$Arch)"

# 1) 内置 Node：官方 Windows 发行版只要 node.exe 本体即可自包含运行，
#    不下载 npm / corepack / include，省下约 60MB。
$nodeExe = Join-Path $NodeDir 'bin/node.exe'
if (-not (Test-Path $nodeExe)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $nodeExe) | Out-Null
  $url = "https://nodejs.org/dist/$NodeVersion/win-$Arch/node.exe"
  Write-Host "==> downloading node from $url"
  Invoke-WebRequest -Uri $url -OutFile $nodeExe
}
else {
  Write-Host '==> node already staged'
}

# 2) 依赖闭包：
#    --legacy：本仓库的 workspace 依赖是符号链接，非 legacy 模式会拒绝部署。
#    node-linker=hoisted：默认 pnpm 布局顶层全是符号链接，而 Tauri 拷贝
#    resources 时会跳过符号链接，产物会是个空壳。
Write-Host '==> deploying dsh runtime closure'
if (Test-Path $RuntimeDir) { Remove-Item $RuntimeDir -Recurse -Force }
Set-Location $RepoRoot
pnpm --filter deepchat-runtime deploy --prod --legacy --config.node-linker=hoisted $RuntimeDir
if ($LASTEXITCODE -ne 0) { throw "build-desktop-runtime: pnpm deploy failed with $LASTEXITCODE" }

# 3) hoisted 之后仍可能有少量指向仓库源码的软链，脱离仓库就失效，逐个实体化。
#    实体化后可能又带出新的软链，所以反复扫到没有可处理的链接为止。
node -e 'const fs=require(`fs`),path=require(`path`);const root=process.argv[1];const isBin=p=>p.includes(`${path.sep}.bin${path.sep}`);let total=0;for(let pass=0;pass<10;pass++){const links=[];(function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())links.push(p);else if(e.isDirectory())walk(p)}})(root);const pending=links.filter(p=>!isBin(p));if(pending.length===0)break;for(const link of pending){let t;try{t=fs.realpathSync(link)}catch{continue}fs.rmSync(link);fs.cpSync(t,link,{recursive:true,dereference:true});total++}}console.log(`==> materialized symlinks: ${total}`)' (Join-Path $RuntimeDir 'node_modules')

Write-Host "==> runtime staged at $Stage"
