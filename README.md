# Chat Agent

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）构建的**本地 AI 好友聊天桌面工具**。

创建多位具备人设、技能与工具权限的 AI 好友，与它们一对一私聊，或拉一个群让多位 AI 按「规则 + 概率」自主发言、互相接话。

**全部数据留在本机**，不依赖任何服务端。

---

## 这是什么

本项目把 AI 好友聊天的业务能力，以**插件**形式构建在 DeepSeek Harness 之上：

- **运行内核全部复用 dsh** —— agent loop、工具系统、LLM 适配、会话事件日志、HTTP/WS 传输、Cordis 插件树
- **聊天业务自建** —— AI 好友、群聊触发引擎、长期记忆、桌面 UI
- **UI 沿用原 chat-agent** —— Tauri 2 + Vue 3，通信层从 stdin/stdout 换成 HTTP + SSE

> 上游框架的文档完整保留在 [`docs/`](docs/)（219 篇）与 [`README.zh.md`](README.zh.md) 中。本文件只描述本项目自身。

## 核心特性

**AI 好友**
- 人设（persona）注入、头像、简介、独立工作目录
- 按好友粒度勾选可用工具、技能、MCP 服务
- Agent 能力开关：关闭后即纯聊天，不向模型暴露任何工具
- **长期记忆**：每次清空对话时，自动把这段关系沉淀成 `MEMORY.md`；跨会话持久，清空聊天记录不会丢失，可在编辑弹窗中查看与手动修改

**群聊**
- 多位 AI 同群，按触发规则自主发言：`@名字` 必答 → 冷却窗口 → 关键词命中 → 基础概率
- 每个（群, 好友）组合持有独立会话记忆，群聊经历与私聊互不串扰
- AI 之间可连锁接话（最多 3 轮）

**模型**
- 支持 OpenAI / Anthropic 及任意 OpenAI 兼容端点
- 模型配置与 API Key 存于本地凭据文件
- 未配置任何 Key 时，联网搜索自动降级到免密钥的兜底通道

**桌面端**
- 深色主题，流式打字机输出
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

## 快速开始

**环境要求**

- [Node.js](https://nodejs.org/) ≥ 20
- [pnpm](https://pnpm.io/) ≥ 9
- [Rust](https://www.rust-lang.org/) 工具链（构建桌面端）

**运行桌面应用**

```bash
cd deepseek-harness
pnpm install --ignore-scripts
pnpm run build          # 构建 host + client

cd apps/desktop
pnpm tauri dev          # 首次编译 Rust 约 1-2 分钟
```

**仅调试后端**

```bash
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent
curl http://127.0.0.1:3180/chatapi/bots
```

## 数据存放

所有数据位于 `DSH_HOME`（开发模式为 `repo/.dsh-home`），在设置页「数据目录」中可直接打开。

| 路径 | 内容 |
|---|---|
| `storages/` | 结构化数据（好友、群聊、模型配置），JSON 持久化 |
| `workspace/agents/` | 每个好友一个目录：工作文件 + `memory/MEMORY.md` |
| `workspace/groups/` | 群聊共享工作文件 |
| `sessions/` | 会话事件日志（zstd 压缩 JSONL，仅追加） |
| `skills/` | 已安装的技能包 |
| `logs/` | 运行日志（`debug.log`） |

会话是**仅追加的事件日志**，界面上的消息是按 turn/prompt 聚合投影出来的，不是数据库行。

## 关键约定

| 项 | 约定 |
|---|---|
| 服务端口 | `127.0.0.1:3180` |
| 会话 id | 私聊 `private:{botId}`，群聊 `{groupId}` |
| 消息 id | 用户消息 `u-{seq}`，AI 消息 `m-p{promptSeq}` |
| 模型路由 id | `chat-{modelId}` |
| 凭据 ref | `CHAT_AGENT_MODEL_{ID大写}` |
| 好友 id | `bot-{uuid}` |

## 开发说明

- 插件遵循 Cordis 规范：`export const name` / `inject` / `Config` / `apply(ctx, config)`
- `settings` 与 `credentials` **不可写入模块级 `inject`**（会导致启动死锁），须用 `ctx.inject()` 动态注入
- 同一插件内多次 `storageDomain.open` 会抛 `json backend is closed`，所有表须共享一个 domain 句柄
- 修改 `packages/chat/*` 后需重新 `tsdown` 打包，**并重启宿主进程**才会生效（profile 是软链，但已加载的模块不会热更新）
- 消息历史分页用游标（`?before=<seq>`）而非 offset，避免追加新消息时错位

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
