# 后端插件（packages/chat/）

三个插件包，遵循 Cordis Loader 插件规范（`export const name` / `inject` / `Config` / `apply(ctx, config)`）。

## 1. chat-bots（bot 注册表 + 私聊 + 各类端点 + SSE）

**位置**：`packages/chat/chat-bots/src/`

**文件**：
- `index.ts` — 插件主体 + HTTP 端点 + SSE + agent 生命周期
- `bridge.ts` — 事件翻译器（详见 02）
- `models.ts` — 自定义模型记录 + llm-pi-ai 路由同步
- `agent-setup.ts` — **共享 agent 能力装配**（私聊/群聊两插件复用）
- `skills-remote.ts` — skills.sh 搜索 + GitHub 安装
- `llm-trace.ts` — LLM 调用追踪记录器（调试面板「对话信息」）
- `schema.ts` — zod schema（botRecordSchema）
- `types.ts` — BotRecord / BotCreateInput / BotUpdatePatch / TriggerConfig

**关键声明**：
```ts
export const name = 'chat-bots'
export const inject = ['agents', 'tools', 'skills', 'storageDomain', 'webServer']
```

> 注意：`settings`/`credentials` **不在模块级 inject 里**（否则启动死锁，见 07-pitfalls），
> 而是用 `ctx.inject(['settings','credentials'], cb)` 动态注入 + `servicesReady` Promise 在 handler 内 await。

**BotRecord 字段**：
```ts
interface BotRecord {
  id: string              // bot-{uuid}
  name: string            // 群聊 @name
  avatar?: string
  persona: string         // 注入 agent 的 persona prompt section
  provider: string        // llm-pi-ai 路由 id（chat-{modelId}）
  model: string           // 模型 id（发给 provider）
  trigger: TriggerConfig  // { activeRate, keywords, cooldownSeconds }
  sessionId: SessionId    // 私聊会话（bot 记忆）
  deletedAt?: number      // 软删墓碑
  introduction?: string   // 会话列表副标题
  agentEnabled?: boolean  // 显式 Agent 能力开关
  workspaceDir?: string   // workspace/agents/{botId}
  enabledTools?: string[]   // 工具白名单（空 = 全部可用，旧版语义）
  enabledSkills?: string[] // 技能白名单（空 = 无技能；chat bot 不吃整个开发技能目录）
  enabledMcpServers?: string[] // MCP 白名单（仅持久化，运行时接线待迁移）
  createdAt / updatedAt
}
```

**HTTP 端点（`/chatapi/bots`）**：
- `GET /chatapi/bots` — 列表（过滤软删 + enrich）
- `POST /chatapi/bots` — 创建（自动分配 workspaceDir + 建目录）
- `GET/PUT/DELETE /chatapi/bots/:id` — 单条 / 更新 / 软删
- `POST /chatapi/bots/:id/send` — 私聊发送
- `POST /chatapi/bots/:id/clear` — 清空会话（换新 session + 删日志 + 广播 message.cleared）
- `GET /chatapi/bots/:id/history` — 富化历史（renderPrivateHistory）

**其它端点**（同文件注册）：
- `/chatapi/models` — 模型 CRUD
- `/chatapi/skills` — 技能 list/create/delete/install-local
- `/chatapi/tools` — 工具注册表投影
- `/chatapi/misc` — open-dir / default-workspace-dir / conversation-previews
- `/chatapi/events` — SSE 事件流（业务事件下行）

**agent 生命周期**：
- `ensureAgent(id)`：resume 失败则 create；`setup = buildBotAgentSetup(ctx, bot, skillSummaries)`（agent-setup.ts）
- `handles: Map<botId, AgentHandle>` 缓存
- `update()` 在 model / persona / agentEnabled / 三个能力白名单变更时 dispose 并重建 agent；
  部分 patch 不带白名单字段时**不得**经 record spread 抹掉已存值（update 内已做 undefined 剥离）

**agent-setup.ts 能力装配**（chat-bots 与 chat-group 的 ensureBotAgent 共用）：
1. persona prompt section（`chat:persona`）
2. Agent 关闭三重防线（suppressTools + `chat:no-tools` section + tools.guard）
3. 工具白名单：`agentCtx.tools.restrict({ allow })`（scoped restrict 只过滤该 agent 继承的全局工具面，
   schema 不发给模型；本层注册的 skill 工具不受影响；名单为空 = 全部可用）
4. 技能：`resolveEnabledSkills()` 先异步解析（setup 必须同步），命中注册
   `chat:skills` 目录 section + scoped `skill` 工具（对齐旧版 createSkillTool + formatSkillsForPrompt）
5. openUrl 工具（旧版 createOpenUrlTool 迁移）：scoped 注册，后端仅做
   目标校验/归一化（http/file:// /本地路径），**打开方式由前端分流** ——
   messages.ts 在 agent.tool.start 记录 args、tool.end 成功后调
   utils/browser `openUrl()`，按 `default_browser` 设置走内置浏览器窗口
   或 `tool.openUrl`（misc open-dir 系统命令）

## 2. chat-group（群聊编排）

**位置**：`packages/chat/chat-group/src/`

**文件**：
- `index.ts` — 插件主体 + 容器会话 + 触发编排 + HTTP
- `trigger.ts` — 触发规则引擎（从旧 `cli/src/core/trigger.ts` 平移）
- `schema.ts` — groupRecordSchema / botSessionRecordSchema
- `types.ts` — GroupRecord / GroupMessageView 等

**关键声明**：
```ts
export const name = 'chat-group'
export const inject = ['chatBots', 'agents', 'storageDomain', 'webServer', 'tools']
```

**双真源结构**（核心设计）：
- **群容器 session**：`GroupRecord.sessionId` —— 只记群消息流（`group/user-message` + `group/bot-message`），UI 渲染/fork/导出/搜索全走它
- **每 (群, bot) 独立 session**：`bot_sessions` 表（key = `{groupId}:{botId}`）—— bot 的群聊记忆，与私聊 session 分离
- `ensureBotAgent` 的 setup 复用 chat-bots 导出的 `buildBotAgentSetup`（persona/三重防线/工具白名单/技能装配一致），按 botUpdatedAt 缓存

**触发引擎（trigger.ts）** 优先级：
1. `@name` → 必回（免冷却）
2. 冷却窗口内 → 跳过
3. 关键词命中 → `activeRate` 概率
4. 否则 → `activeRate` 基础概率

**@ 定向规则**（runCascade）：首条用户消息若 @ 了成员，未被 @ 的成员跳过（仅限 round 0，后续 AI 连锁轮不限制）。

**HTTP 端点（`/chatapi/groups`）**：
- `GET/POST /chatapi/groups` — 列表 / 创建（分配 workspaceDir）
- `GET/PUT/DELETE /chatapi/groups/:id`
- `POST /chatapi/groups/:id/send` — 群发消息
- `POST /chatapi/groups/:id/clear` — 清空（容器 + 所有 bot 群记忆）
- `GET /chatapi/groups/:id/history`
- `/chatapi/group-misc` — conversation-previews（群预览）

**cascade 流程**：
```
用户消息 → append 到容器 session → 触发引擎评估 → 逐 bot：
  inject(群上下文，标注发言者 + 最近 N 条) → followup 唤醒 → whenIdle 等待
  → assistant/message 落地 → append 回容器（带 senderId）→ 再次评估 → 直到无人响应或 MAX_GROUP_ROUNDS(3)
```

## 3. chat-agent（bundle 组合层）

**位置**：`packages/chat/chat-agent/cordis.patch.yml`

**职责**：把 dsh-base + 存储栈 + transport + chat 插件族组合成一个 bundle。

**关键 patch**：
```yaml
- id: system-prompt        # persona 置空（persona 由 chat-bots per-agent 注入）
- id: agent-instructions   # maxBytes: 0 → 禁用仓库 AGENTS.md 注入
- id: tool-skill           # disabled → 移除模型侧技能目录 + skill 工具
- id: hmr                  # disabled
- id: tools                # mode 由 DSH_TOOLS_MODE 控制
# insert:
- storage / storage-json / storage-domain   # 存储栈（json backend，root=storages）
- workspace / directory-picker              # 满足 api-gateway inject
- webserver (127.0.0.1:3180)               # transport
- api-gateway                              # 标准 RPC
- chat-bots / chat-group (maxGroupRounds:3, contextWindow:20)
```

## profile 与运行

**profile 位置**：`.dsh-home/profiles/chat-agent/package.json`

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-base": "workspace:^",
    "@deepseek-ai/dsh-chat-agent": "workspace:^",
    "@deepseek-ai/dsh-chat-bots": "workspace:^",
    "@deepseek-ai/dsh-chat-group": "workspace:^"
  },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-chat-agent"] } }
}
```

> profile 必须显式依赖所有被插入的插件（pnpm isolated linker 只暴露直接依赖）。

**运行**：`DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent`
