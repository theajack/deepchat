# 模型 / 技能 / 工具管理

## 1. 模型（/chatapi/models）

**文件**：`chat-bots/src/models.ts`

**ModelRecord** 字段（snake_case 对旧 `ai_models` 表）：
```ts
{ id, name, provider, base_url, api_key, model_name, tool_use, image_input,
  reasoning_mode, custom_protocol, input_ctx, output_ctx, created_at, updated_at, route_id }
```

**核心机制 —— llm-pi-ai 路由同步**：

每条模型记录映射为一个 llm-pi-ai hand-declared provider route：
- route id = `chat-{modelId}`
- 凭据 ref = `CHAT_AGENT_MODEL_{ID大写}`
- 协议映射：openai/custom/deepseek → `openai-completions`，anthropic → `anthropic-messages`
- 默认 baseURL：openai / anthropic / deepseek 有默认值，custom 必填

```ts
syncRoute(ctx, record, apiKey)   // credentials.set + settings.replace(providers[routeId])
removeRoute(ctx, id, provider)   // 删除路由 + credentials.unset（整段重写）
```

> 关键：删除路由必须用 `settings.replace` 整段重写（merge update 无法删除 key）。

**CRUD 端点**：
- `GET /chatapi/models` — 列表
- `POST /chatapi/models` — 创建 + 同步路由
- `PUT /chatapi/models/:id` — 更新 + 重同步
- `DELETE /chatapi/models/:id` — 删除记录 + 路由 + 凭据

**默认模型逻辑**（前端 ipc.ts）：
- `model.create` 成功后，若无 `default_model_id` → 自动设为新模型
- `model.delete` 若删除的是默认模型 → 设第一个剩余模型为默认（无则清空）
- 删除确认用应用内 `ConfirmDialog`（Tauri 禁用原生 `window.confirm`）

## 2. 技能（/chatapi/skills）

**文件**：`chat-bots/src/index.ts`（skills 端点）

接入 dsh skill registry（`ctx.skills`）：

- `GET /chatapi/skills` — 投影 `ctx.skills.snapshot()` + `get(name)`（bundled + user + project）
- `POST /chatapi/skills` — 从模板创建（写入 `$DSH_HOME/skills/{name}/SKILL.md`）
- `DELETE /chatapi/skills/:name` — 仅允许删 user-dsh 根下的技能
- `POST /chatapi/skills/install-local` — 本地目录批量安装

**前端映射**（ipc.ts）：`skill.list/create/delete/installLocal`；`skill.find`（GitHub 搜索）与 `skill.installGithub` 留待 M4。

**注意**：bundle 里 `tool-skill` disabled —— 技能目录不注入模型（chat bot 不该吃开发技能目录），但 `dsh-skill` registry 保留给设置页。

## 3. 工具（/chatapi/tools）

- `GET /chatapi/tools` — 投影 `ctx.tools.schemas()` 全局注册表
- 前端 `tool.listAll` 映射

**工具名显示 bug 修复**（重要）：

`agent.tool.start` 到达时，若条目已被更早的 `tool.args` 增量帧创建（那时 name 为空，因为 delta chunk 本身不含工具名），**必须回填 name**：
```ts
if (t) {
  if (d.name) t.name = d.name      // 关键：回填权威 name
  if (d.args !== undefined) t.args = d.args
}
```
否则「流式输出工具参数的模型」工具名永远为空（只显示「工具」兜底）。

## 4. misc 端点（/chatapi/misc）

- `open-dir` — spawn `open`/`explorer`/`xdg-open`（支持 `~` 展开）
- `default-workspace-dir` — 返回 `~/chat-agent-workspace`（自动建目录）
- `conversation-previews` — 返回各会话最后一行（列表预览）

## 5. 上下文注入抑制（重要修复）

bundle patch 关闭了三个开发向注入，否则聊天好友首条消息会被塞入约 27KB 无关上下文：

```yaml
- id: agent-instructions   # maxBytes: 0（否则仓库 AGENTS.md 16KB 被喂给 bot）
- id: tool-skill           # disabled（否则 ~/.agents 技能目录 10KB + skill 工具）
```

这曾导致「新好友拿到上一个 Agent 上下文」的观感，实为目录树向上收集 AGENTS.md 所致。
