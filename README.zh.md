# DeepChat

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）构建的**本地 AI 好友聊天桌面工具**。

创建多位具备人设、技能与工具权限的 AI 好友，与它们一对一私聊，或拉一个群让多位 AI 按「规则 + 概率」自主发言、互相接话。

**全部数据留在本机**，不依赖任何服务端。

<p align="center">
    <a href='https://www.github.com/theajack/deepchat'>
        <img src='./website/deepchat_icon.png' width='240px'/>
    </a>
</p>

---

## 这是什么

本项目把 AI 好友聊天的业务能力，以**插件**形式构建在 DeepSeek Harness 之上：

- **运行内核全部复用 dsh** —— agent loop、工具系统、LLM 适配、会话事件日志、HTTP/WS 传输、Cordis 插件树
- **聊天业务自建** —— AI 好友、群聊触发引擎、长期记忆、桌面 UI
- **UI 沿用原 chat-agent** —— Tauri 2 + Vue 3，通信层从 stdin/stdout 换成 HTTP + SSE

> 上游框架的文档完整保留在 [`docs/`](docs/)（219 篇）中。本文件描述本项目自身，英文版见 [`README.md`](README.md)。

## 如何启动

**环境要求**

- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/) ≥ 9
- [Rust](https://www.rust-lang.org/) 工具链（构建 Tauri 桌面端）

**1. 安装依赖并构建 dsh 内核**

桌面端通过 `node apps/cli/lib/bin.js --profile chat-agent` 拉起后端宿主，因此**必须先构建内核**，否则启动时会报「无法定位 dsh」。

```bash
cd deepseek-harness
pnpm install --ignore-scripts
pnpm run build          # 构建 host + client，产出 apps/cli/lib/
```

**2. 启动桌面应用**

```bash
cd apps/desktop
pnpm tauri dev          # 首次编译 Rust 约 1–3 分钟
```

`pnpm tauri dev` 做了两件事：

1. 执行 `beforeDevCommand`（`pnpm dev`），起 Vite 前端开发服务器 `http://localhost:1420`
2. 由 Rust 侧 `spawn_dsh` 拉起 dsh 宿主，轮询 `127.0.0.1:3180` 直到就绪，再通知前端开始请求

**3. 其他运行方式**

```bash
# 只跑前端（后端另起一个终端），适合调试 UI
cd apps/desktop && pnpm dev
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent

# 只调试后端，不开桌面端
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent
curl http://127.0.0.1:3180/chatapi/bots

# 指定自定义宿主命令（覆写默认的仓库内 CLI）
DEEPCHAT_DSH_CMD="node /abs/path/to/bin.js" pnpm tauri dev
```

**打包桌面应用**

```bash
bash scripts/build-desktop.sh
```

产物：`apps/desktop/src-tauri/target/release/bundle/dmg/DeepChat_0.1.0_aarch64.dmg`（约 130MB，安装后 512MB）。

打包过程中 `scripts/build-desktop-runtime.sh` 会把 dsh 运行时塞进 app：下载一份 Node 二进制，再用 `pnpm deploy` 导出 dsh CLI 与 chat 插件的生产依赖闭包，一并放进 `Contents/Resources`。**拿到 dmg 的人不需要装 Node，也不需要克隆仓库**，双击即用。

运行期数据（好友、群聊、会话、记忆、图片）落在 `~/Library/Application Support/com.deepchat.desktop/dsh-home`，与开发用的 `repo/.dsh-home` 是两份，互不影响。

> 为什么不是直接 `pnpm tauri build`：pnpm 11 会在运行命令前校验依赖，必要时自己执行 `pnpm install --production`，把 devDependencies 剪掉，打包还没开始就断在这里。脚本里已关掉这个校验（`pnpm_config_verify_deps_before_run=false`，pnpm 只认环境变量，`.npmrc` 无效）。
>
> 打包未使用开发者证书签名，别人首次打开需在「系统设置 → 隐私与安全性」点「仍要打开」，或执行 `xattr -rd com.apple.quarantine /Applications/DeepChat.app`。

> 修改 `packages/chat/*` 后需重新构建插件包（`tsc -b` + `tsdown`）**并重启宿主进程**才会生效：Vite 前端可热更新，但已加载的 node 模块不会热替换。

## 核心特性

**AI 好友**
- 人设（persona）注入、头像、简介、独立工作目录
- 按好友粒度勾选可用**工具 / 技能 / MCP 服务**（专用选择器，不再手工填文本）
- Agent 能力开关：关闭后即纯聊天，不向模型暴露任何工具
- **AI 辅助生成**：一句话生成人设、自我介绍、群聊介绍，SSE 流式落进输入框
- **长期记忆**：清空对话时自动把这段关系蒸馏成 `MEMORY.md`；跨会话持久，清空聊天记录不丢失，可在编辑弹窗里查看与手动改写
- **克隆好友**：一键复制出配置相同、身份全新的好友 —— 复制人设 / 模型 / 工具 / 技能 / 头像文件与长期记忆，并立刻把源好友的会话蒸馏进克隆体的记忆；命名自动递增（`小艺` → `小艺-克隆体` → `小艺-克隆体2`）

**群聊**
- 多位 AI 同群，按触发规则自主发言：`@名字` 必答 → 冷却窗口 → 关键词命中 → 基础概率
- **主动发言**：可选开启，群内空闲满 N 分钟后由 AI 自己起话题（默认 5–10 分钟随机，避免成员同时开口）
- 每个（群, 好友）组合持有独立会话记忆，群聊经历与私聊互不串扰
- **群共享工作区**：群与每位成员各有工作目录，注入上下文后由 AI 按任务自选读写
- AI 之间可连锁接话（最多 3 轮）

**会话与界面**
- 深色主题，流式打字机输出；中英双语（跟随系统，可手动切换）
- 会话置顶、清空记录、删除会话；列表右键菜单（好友：发消息 / 克隆 / 删除；群聊：解散，带二次确认）
- **图片与附件持久化**：发送的图片落盘到 `$HOME/chat-agent-images/<会话 id>/`，历史图片自动迁移，重启后仍可渲染

**模型**
- 支持 OpenAI / Anthropic 及任意 OpenAI 兼容端点
- 模型配置与 API Key 存于本地凭据文件
- 未配置任何 Key 时，联网搜索自动降级到免密钥的兜底通道

**桌面端**
- 工具调用卡片：实时展开参数与执行结果，长耗时工具可见进度而非干等
- 会话列表、好友列表、历史消息均采用分页 / 增量渲染，长列表不卡
- 内置调试面板：LLM 调用瀑布流、运行日志

## 架构

```
┌─────────────────────────────────────────────┐
│  Tauri 2 桌面端 (apps/desktop)              │
│  Vue 3 + Pinia + Tailwind 4                 │
└──────────────────┬──────────────────────────┘
                   │ HTTP / SSE  127.0.0.1:3180
┌──────────────────▼──────────────────────────┐
│  chat 插件族 (packages/chat/)               │
│  chat-bots   好友注册表 + 私聊 + 模型/技能  │
│  chat-group  群聊编排 + 触发引擎            │
│  chat-agent  bundle 组合层 (cordis.patch)   │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  DeepSeek Harness 内核                      │
│  agent-loop · tools · llm · session · http  │
└─────────────────────────────────────────────┘
```

一次对话的完整链路：

```
用户发消息
  → POST /chatapi/bots/:id/send    （群聊走 /chatapi/groups/:id/send）
  → ensureAgent → agent.followup()
  → dsh agent-loop 执行，turn 内可多轮工具调用
  → 会话事件流经 bridge.ts 翻译成前端事件
  → SSE /chatapi/events 推送
  → 前端渲染：message.stream → 打字机 → message.created
```

## 目录结构

```
deepseek-harness/
├── apps/
│   ├── desktop/            # Tauri 2 桌面应用（本项目 UI）
│   ├── cli/                # dsh CLI 入口
│   └── web/                # dsh 原生 Web UI（调试用）
├── packages/
│   ├── chat/               # 本项目业务插件
│   │   ├── chat-bots/      #   好友 + 私聊 + 模型/技能/工具端点
│   │   ├── chat-group/     #   群聊编排 + 触发引擎
│   │   └── chat-agent/     #   bundle 组合层
│   └── ...                 # dsh 原有包
├── .dsh-home/              # 开发态 DSH_HOME（gitignore）
├── chat-agent-context/     # 迁移与设计文档
└── docs/                   # 上游 dsh 文档
```

## 数据存放

所有数据位于 `DSH_HOME`（开发模式为 `repo/.dsh-home`），在设置页「数据目录」中可直接打开。

| 路径 | 内容 |
|---|---|
| `storages/` | 结构化数据（好友、群聊、模型配置），JSON 持久化 |
| `workspace/agents/` | 每个好友一个目录：工作文件 + `memory/MEMORY.md`（长期记忆） |
| `workspace/groups/` | 群聊共享工作文件 |
| `sessions/` | 会话事件日志（zstd 压缩 JSONL，仅追加） |
| `skills/` | 已安装的技能包 |
| `logs/` | 运行日志（`debug.log`） |
| `$HOME/chat-agent-images/` | 会话图片附件（按会话 id 分目录，供 webview 直接加载） |

会话是**仅追加的事件日志**，界面上的消息是按 turn/prompt 聚合投影出来的，不是数据库行。

## 关键约定

| 项 | 约定 |
|---|---|
| 服务端口 | 后端 `127.0.0.1:3180`，前端 dev 服务器 `localhost:1420` |
| 会话 id | 私聊 `private:{botId}`，群聊 `{groupId}` |
| 消息 id | 用户消息 `u-{seq}`，AI 消息 `m-p{promptSeq}` |
| 模型路由 id | `chat-{modelId}` |
| 凭据 ref | `CHAT_AGENT_MODEL_{ID大写}` |
| 好友 id | `bot-{uuid}` |
| 克隆命名 | `{原名}-{克隆词}{序号}`，序号为空时首次克隆不加数字 |

## 开发说明

- 插件遵循 Cordis 规范：`export const name` / `inject` / `Config` / `apply(ctx, config)`
- `settings` 与 `credentials` **不可写入模块级 `inject`**（会导致启动死锁），须用 `ctx.inject()` 动态注入
- 同一插件内多次 `storageDomain.open` 会抛 `json backend is closed`，所有表须共享一个 domain 句柄
- 修改 `packages/chat/*` 后需重新 `tsdown` 打包，**并重启宿主进程**才会生效（profile 是软链，但已加载的模块不会热更新）
- 消息历史分页用游标（`?before=<seq>`）而非 offset，避免追加新消息时错位
- 宿主无 i18n 服务，需要本地化文案的参数（如克隆后缀词）由前端按当前语言传入

## 文档索引

迁移背景、插件职责、事件桥接、存储设计等细节见 [`chat-agent-context/`](chat-agent-context/)：

| 文件 | 内容 |
|---|---|
| `00-overview.md` | 项目总览与迁移背景 |
| `01-backend-plugins.md` | 三个 chat 插件的职责与端点 |
| `02-event-bridge.md` | 会话事件到前端事件的翻译 |
| `03-workspace-sandbox.md` | 工作目录与沙箱 |
| `04-models-skills-tools.md` | 模型、技能、工具机制 |
| `05-frontend.md` | 前端架构 |
| `06-storage.md` | 数据存储布局 |
| `07-pitfalls.md` | 已踩过的坑 |
| `08-milestones.md` | 里程碑与待办 |

## 许可

本项目沿用上游 DeepSeek Harness 的许可，详见 [`LICENSE`](LICENSE)。
