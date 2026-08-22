# 工作区与沙箱隔离

## 工作区目录约定

- **好友**：`$DSH_HOME/workspace/agents/{botId}`
- **群聊**：`$DSH_HOME/workspace/groups/{groupId}`

创建时自动 `mkdir` 并写入 `workspaceDir` 字段；旧记录在插件 init 时一次性回填。

## 沙箱接线（复用 dsh 内置，不自研）

dsh-base 默认 `sandbox-policy.mode: workspace-write`，`workspaceRoot = session.header.cwd`。

- bot 私聊 agent 创建时 `meta: { cwd: bot.workspaceDir }`
- 群聊 bot 的群会话 `meta: { cwd: bot.workspaceDir }`（沿用 bot 自己的工作区，旧版语义）
- 群容器 `meta: { cwd: group.workspaceDir }`

**效果**：所有写操作（write/edit/bash 可写根）自动限制在对应工作区内，越界抛 `FS_SANDBOX_DENIED`。

> 已知差异：dsh 沙箱哲学是「写严格围栏，读不限制」（`workspace-write` 只 fence mutation）。
> 旧 chat-agent 的 NodeEnv 是读写都禁。若需严格对齐（读也禁止越界），需 fork 给
> `packages/fs/fs-sandbox` 加 `strictRead` 选项 —— 目前未实施，按需决定。

> 曾经自建 `WorkspaceFencedFs` provider，但**与内置 SandboxedFileSystem 冲突**
> （同一 agent scope 注册两个 `fs` provider），已删除，改回接线 meta.cwd。

## Agent 能力开关（三重防线）

`BotRecord.agentEnabled`（显式字段，创建/更新时由前端传入）。

关闭时（`setup(agentCtx)` 内）：

1. **请求层**：`agentCtx.systemPrompt.suppressTools()` —— fork 给 system-prompt 核心包增加的方法，请求不携带任何工具 schema
2. **提示词层**：注入 section「【重要】你没有任何可调用的工具或技能……请直接以纯文本对话回答」
3. **执行层**：`agentCtx.tools.guard(() => '该好友未开启 Agent 能力，无法调用工具或技能')` 兜底

**fork 核心改动**（`packages/core/system-prompt/src/index.ts`）：
- 新增 `toolSuppressors` anonymous entries
- 新增 `suppressTools(): () => void`（照 `suppressRuntimeContext` 模式）
- `isEmpty()` 计入 toolSuppressors
- assemble 收集工具时 `toolsSuppressed ? [] : orderTools(...)`

**兼容**：旧记录无 `agentEnabled` 字段时回退 `agentEnabled ?? workspaceDir !== undefined`。

**前端**：禁用 Agent 的好友不显示「打开文件夹」工具栏按钮（`ChatInputToolbar.vue` 条件渲染）。

## agentEnabled 变更重建

`update()` 检测 `agentEnabled` 变化 → dispose 并重建 agent（否则 guard/suppressTools 状态残留）。
群聊侧靠 `botUpdatedAt` 缓存失效自动重建。
