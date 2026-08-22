# 数据存储

所有数据在 **DSH_HOME**（dev = `repo/.dsh-home`）下，分三类。

## 1. 结构化数据（storage-domain JSON）

**backend**：`storage-json`，root = `$DSH_HOME/storages`

| 文件 | 内容 |
|---|---|
| `chat_bots.json` | `bots` 表（好友）+ `models` 表（自定义模型）—— 同 domain `chat_bots` |
| `chat_groups.json` | `groups` 表（群）+ `bot_sessions` 表（群 bot 会话绑定） |

**关键点**：models 表并入 bots domain —— 同一插件二次 `storageDomain.open` 会抛 `json backend is closed`（见 07），所以所有 chat-bots 表共享一个 domain 句柄。

## 2. 会话事件日志（session JSONL）

**位置**：`$DSH_HOME/sessions/{cwd分组}/session-{uuid}/session.jsonl.zstd`

- dsh 会话是**仅追加**事件日志（zstd 压缩 JSONL），不是表行
- 界面消息 = 按 turn/prompt 聚合投影出来的（bridge.ts）
- 可直接查看：`zstd -dc session.jsonl.zstd | head`

**会话 id 对应**：
- 好友私聊 → `BotRecord.sessionId`
- 群容器 → `GroupRecord.sessionId`
- 群 bot 记忆 → `bot_sessions` 表 `{groupId}:{botId}` → sessionId

## 3. 配置与凭据

- `settings.yaml` — llm-pi-ai providers 路由（`providers.chat-{modelId}`）
- `.credentials.yaml` — API Key（`CHAT_AGENT_MODEL_{ID大写}`）

## 清空会话语义

「换新 session + 删旧日志」：
- 好友：dispose 活动 agent → bot 记录换新 `sessionId` → 删旧日志目录
- 群：容器 + 群内所有 (群,bot) 群记忆 session 一起重置
- 广播 `message.cleared` → 前端清本地状态

> 私聊 clear 只重置该 bot 私聊记忆，**不影响其群聊记忆**（群绑定未动，与旧版语义一致）。

## 软删除

`remove()` 软删（写 `deletedAt` 墓碑）：活跃列表过滤，会话历史/消息/群成员关系保留。

## 数据迁移（未实施，M6）

旧 `cli/` 的 SQLite（`data/chat-agent.db`：bots/settings/messages）→ 上述格式的迁移脚本尚未编写。
