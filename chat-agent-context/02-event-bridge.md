# 事件桥与消息聚合（bridge.ts + SSE）

**位置**：`packages/chat/chat-bots/src/bridge.ts`

这是迁移最核心的一层：把 dsh 的 `session/event` 事件翻译成 chat-agent 前端依赖的 legacy 事件形状，再通过 SSE 推给 UI。

## 事件映射

| dsh 事件 | legacy 事件（SSE 下行） |
|---|---|
| `user/message`（source.kind==='user'） | 推进 `promptSeq` 计数器（开启新 run） |
| `turn/start` | `bot.typing` (typing: true) |
| `turn/end` | `bot.typing`(false) + `message.stream`(done) + `message.created` + `conversation.updated` |
| `turn/end`（reason.kind==='error'） | `message.error`（错误消息呈现） |
| `assistant/chunk`（text-delta / reasoning-delta） | `message.stream`（增量） |
| `assistant/chunk`（tool-call-delta） | `agent.tool.args`（参数增量） |
| `tool/call` | `agent.tool.start`（含 name/args） |
| `tool/result` | `agent.tool.end`（含 result/isError） |

## 关键机制

### 1. promptSeq（一次回复 = 一条消息）

```ts
const promptSeqBySession = new Map<string, number>()  // sessionId → 序号

// user/message（可见用户消息）→ +1
// 所有 stream 帧 / 工具帧 / 最终消息共享 draftId = `m-p{promptSeq}`
```

**核心教训**：dsh 的一个 `turn` 就是**一次完整 agent run**（工具调用循环都在同一 turn 内，`turn/end reason=completed` 才结束）。所以：
- 流式草稿 id、`message.stream` done、`message.created`、历史渲染**全部统一为 `m-p{promptSeq}`**
- 早期错误地用 `m-{turn}` 当 created id、`m-p{N}` 当草稿 id，导致草稿与正式消息并存 → **一次输出多个气泡**

### 2. 消息聚合

- `aggregateTurn(session, turn, ...)`：折叠一个 turn → 文本 + segments 时间线 + toolCalls + usage 累计 + 时长
- `aggregatePrompt(session, promptSeq, ...)`：折叠整个 run（罕见多 turn 情况）→ 一条消息

**usage 语义修正**（缓存命中率 bug）：
dsh `TokenUsage` 字段互斥 —— `inputTokens` 仅非缓存输入，缓存读/写单独计。旧 UI 的 `prompt_tokens` 是全量输入，所以：
```ts
promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens
```
否则 `cachedTokens / promptTokens` 会超过 100%（曾出现 7771%）。

### 3. 富化历史渲染

- `renderPrivateHistory(session, botId, botName)`：
  - 用户消息：只保留 `source.kind === 'user'`（过滤 plugin relay / wake notice / system-reminder）
  - AI 消息：按 prompt 分组聚合，一条 run 一条消息
  - 每条行带 `id / kind / time / text / senderId / senderName / segments / toolCalls / promptTokens / completionTokens / cachedTokens / durationMs / stopReason`

### 4. SSE 端点

`chat-bots` 注册 `GET /chatapi/events`：
```ts
res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' })
// 帧格式：data: {"event": "...", "data": {...}}\n\n
```

- 前端用 `EventSource` 直连（带 CORS 头，Tauri webview 与浏览器均可）
- 客户端集合 `sseClients: Set<ServerResponse>`，`broadcast(event, data)` 遍历推送
- `chat-group` 通过 `ctx.chatBots.broadcast(...)` 复用同一通道

## 事件订阅（插件侧）

```ts
this.ctx.on('session/event', (session, event) => {
  // chat-bots：bot 私聊 session → translateSessionEvent
  // chat-group：容器 session（group/*）→ message.created；bot 群 session → stream 帧
})
```

## 前端消费（stores/messages.ts）

`dshTransport.onEvent` 并联两条流：
- SSE `/chatapi/events` → legacy 事件直接透传
- WS `/api/events.mux` → dsh 帧按原样透传（stores 忽略未识别帧）

前端 store 处理的事件：`message.stream` / `message.created` / `message.error` / `message.cleared` / `bot.typing` / `agent.tool.start` / `agent.tool.args` / `agent.tool.end` / `conversation.updated`。
