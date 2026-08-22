# 前端（apps/desktop）

Vue 3.5 + Pinia + Tailwind CSS v4 + Lucide 图标 + Tauri 2。

## 技术栈要点

- **Tailwind v4**：`style.css` 用 `@import "tailwindcss"`，工具类（含 `overscroll-contain`）默认内置，无 config 文件
- **i18n**：`src/i18n/zh.ts` / `en.ts`，`t()` 函数
- **主题**：黑暗模式（用户规则），`stores/theme.ts`

## 目录结构

```
src/
├── services/
│   ├── transport/
│   │   └── dsh.ts              # dshRpc / dshGet / dshSend / dshEvents(WS) / dshChatEvents(SSE)
│   ├── ipc.ts                  # DshTransport：method 名 → HTTP 端点映射（核心迁移层）
│   ├── chatApi.ts / agentApi.ts  # 门面，保留旧接口形状
├── stores/                     # Pinia：messages / bots / conversations / models / settings / ...
├── components/
│   ├── chat/                   # MessageList / MessageBubble / ToolCallCard / ChatInput / ChatHeader / ChatInputToolbar / ConversationList
│   ├── contacts/               # BotEditorModal / BotAgentFields 等
│   ├── settings/               # ModelList / SkillsPanel / ToolsPanel 等
│   ├── common/  layout/  selectors/  browser/  debug/  skills/
├── views/  types/  utils/  i18n/
└── App.vue  main.ts
```

## transport 层（services/transport/dsh.ts）

- `dshBaseUrl()` — `http://127.0.0.1:3180`
- `dshGet` / `dshSend(method, path, body)` — HTTP 封装（plugin-http 免 CORS）
- `dshEvents` — WS `/api/events.mux`（dsh 帧，自动重连 3s）
- `dshChatEvents` — SSE `/chatapi/events`（业务 legacy 事件，EventSource 自动重连）

## ipc.ts —— 核心迁移层

`DshTransport.request(method, params)` 把旧 chat-agent 的方法名映射到新端点：

| 旧方法 | 新端点 |
|---|---|
| `bot.list/create/update/delete/get` | `/chatapi/bots` CRUD |
| `message.send` | `/chatapi/bots/:id/send` 或 `/chatapi/groups/:id/send` |
| `message.list` | `/chatapi/bots/:id/history` / `/chatapi/groups/:id/history` |
| `message.clear` | `/chatapi/bots/:id/clear` / `/chatapi/groups/:id/clear`（按 `private:` 前缀分流） |
| `conversation.list` | `/chatapi/bots` + `/chatapi/groups` + previews |
| `model.*` | `/chatapi/models` |
| `skill.*` | `/chatapi/skills` |
| `tool.listAll` | `/chatapi/tools` |
| `tool.openDir/openUrl` | `/chatapi/misc` open-dir |
| `llm.trace.list` | 返回空列表（未迁移，消除噪音） |

**toFrontBot / toFrontMessage / toFrontTrigger**：dsh 数据 → 旧前端类型（FrontBot/FrontMessage/FrontConversation）转换。

## 关键修复记录（前端）

1. **唯一键反查**：所有「按名字匹配 bot」改为「从会话 id `private:{botId}` 解析 botId 反查」—— 否则同名好友头像串
2. **工具名回填**：`agent.tool.start` 回填 name（见 04）
3. **清空残留**：`message.cleared` 事件清空消息/草稿/typing/toolCalls/segments
4. **弹性滚动**：根容器 + 消息区 + 会话列表加 `overscroll-contain`（阻止 macOS 弹性穿透）
5. **气泡间距**：根容器 `gap-0`、时间 span 去 `px-1`（时间贴气泡）；统计行 `-bottom-5` + AI 气泡 `mb-2.5`
6. **确认弹窗**：删除模型用 `ConfirmDialog`（Tauri 禁用 `window.confirm`）
7. **loading 头像**：typing key 的 botId 提取改 `.pop()`（key 是 `conv:botId`，conv 含冒号）
8. **Vue 坑**：临时 `watchEffect` 未 import 导致 `Can't find variable`，已删除调试代码

## Rust 侧（src-tauri/src/lib.rs）

- spawn `dsh --profile chat-agent`（`DSH_HOME=repo/.dsh-home`）+ 端口就绪探测
- 子进程退出监听（`Arc<Mutex<Child>>` + `try_wait` 轮询）
- 保留浏览器 tab 控制（webview.eval）
- `tauri.conf.json` 已移除旧 `externalBin`
