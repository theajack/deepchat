# 项目总览与迁移背景

## 目标

将 `chat-agent`（原 Tauri 2 桌面端 AI 好友聊天应用）的运行底座从**自研单体 CLI**切换到 **deepseek-harness（dsh）**：

- **底座（运行内核）**：全部复用 dsh —— agent loop、工具系统、LLM 适配、会话事件日志、HTTP/WS API、插件树（Cordis）
- **UI 与业务逻辑**：保留 chat-agent 原有 —— AI 好友、群聊触发引擎、聊天向 UI
- **形态**：dsh 整体作为 fork 仓库（`deepseek-harness/`），chat-agent 的业务能力以「插件 + bundle + profile + Tauri 应用」方式落进来

## 架构对比

| 维度 | chat-agent（旧） | deepseek-harness（新） |
|---|---|---|
| 内核 | `cli/`(Bun) 自研 agent loop / 工具注册表 / 审批 / MCP / skills | Cordis 插件树，一切皆插件（profile + bundle 分层组装） |
| Agent 循环 | 自研 loop | dsh `core/agent-loop`：turn/step 事件流、inbox、inject |
| 工具系统 | 自研 `agent/tools/*` + `registry.ts` | `ctx.tools` 作用域注册表 + 把关执行流水线 |
| LLM 适配 | 自研 OpenAI/Anthropic Provider | `ctx.llm` seam，`llm-pi-ai`（多厂商） |
| 会话/持久化 | SQLite 表（messages/conversations/…）+ Repo | 追加式 `SessionEvent` 日志（JSONL zstd）+ storage-domain JSON |
| Skills | 自研 SKILL.md 机制 | dsh `dsh-skill`（同为 SKILL.md 机制） |
| API/IPC | JSON Lines over stdin/stdout | HTTP `POST /api/<method>` + WS mux + SSE |
| UI | Tauri 2 + Vue3 + Pinia + Tailwind4 | Tauri 2 + Vue3（保留），通信层换成 HTTP/WS/SSE |
| 多 AI 协作 | 群聊触发规则引擎 | 无群聊一等概念，由 chat-group 插件自建编排 |

## 目录结构（迁移后）

```
deepseek-harness/                     # dsh fork（vendor 锁定）
├── apps/
│   ├── desktop/                      # Tauri 2 桌面应用（Vue UI，来自旧 app/）
│   │   ├── src/
│   │   │   ├── components/           # chat / contacts / settings / skills / ...
│   │   │   ├── services/             # ipc.ts / chatApi.ts / agentApi.ts / transport/
│   │   │   ├── stores/               # messages / bots / conversations / models / ...
│   │   │   ├── views/  types/  i18n/  utils/
│   │   │   └── App.vue  main.ts  style.css
│   │   └── src-tauri/                # Rust：spawn dsh + 端口探测 + 浏览器 tab 控制
│   ├── web/                          # dsh 原生 Web UI（保留调试用）
│   └── cli/                          # dsh CLI（dsh 命令入口）
├── packages/
│   ├── ...                           # dsh 全部原有包（不动）
│   └── chat/
│       ├── chat-bots/                # bot 注册表 + 私聊 + 模型/技能/工具/misc 端点 + SSE
│       ├── chat-group/               # 群聊编排 + 触发引擎 + 容器会话
│       └── chat-agent/               # bundle：cordis.patch.yml 组合层
├── .dsh-home/                        # 开发态 DSH_HOME（gitignore）
│   ├── profiles/chat-agent/          # profile：workspace 链接到 bundle
│   ├── workspace/                    # agents/{botId} / groups/{groupId}
│   ├── storages/                     # chat_bots.json / chat_groups.json
│   ├── sessions/                     # 会话事件日志（zstd JSONL）
│   ├── settings.yaml                 # llm-pi-ai 路由
│   └── .credentials.yaml             # API Key
└── chat-agent-context/               # 本文档集
```

## 关键约定

- **端口**：dsh host 监听 `127.0.0.1:3180`
- **DSH_HOME**：dev 模式指向 `repo/.dsh-home`（Rust `lib.rs` 显式设置）
- **会话 id 约定**：私聊 `private:{botId}`，群聊 `{groupId}`
- **消息 id 约定**：用户消息 `u-{seq}`，AI 消息 `m-p{promptSeq}`（一次完整 run 一条）
- **模型路由 id**：`chat-{modelId}`（llm-pi-ai provider key）
- **凭据 ref**：`CHAT_AGENT_MODEL_{ID大写}`

## 生命周期总览

```
用户发消息（前端）
  → HTTP POST /chatapi/bots/{id}/send 或 /chatapi/groups/{id}/send
  → chat-bots / chat-group 插件：ensureAgent → agent.followup(inject 上下文)
  → dsh agent-loop 执行（turn 内工具循环）
  → session/event 事件 → bridge.ts 翻译 → SSE /chatapi/events 推前端
  → 前端 stores 消费 legacy 事件形状（message.stream / message.created / bot.typing / agent.tool.*）
```
