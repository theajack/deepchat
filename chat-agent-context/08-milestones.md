# 里程碑与待办

## 已完成（M0–M5 主体）

- [x] M0 spike：验证 profile boot + HTTP API + WS 事件帧
- [x] M1 底座裁剪：`bundle-chat-agent` + `chat-agent` profile + `apps/desktop` 骨架
- [x] M2 模型凭据：`/chatapi/models` + llm-pi-ai 路由 + credentials；默认模型逻辑
- [x] M3 私聊链路：chat-bots + transport 适配 + 流式 + 富化历史
- [x] M4 群聊：chat-group 编排 + 触发引擎 + @定向 + 容器会话 + 会话隔离
- [x] M5 工具/交互：SSE 事件桥 + 工具卡片 + 清空会话 + workspace 沙箱 + Agent 能力开关
- [x] 技能管理：`/chatapi/skills`（list/create/delete/install-local）
- [x] 上下文注入抑制（AGENTS.md / skill-catalog）
- [x] 会话独立性与清空（软删保留历史）
- [x] 前端若干 UX 修复（头像唯一键、气泡间距、弹性滚动、确认弹窗、工具名回填）

## 待办

### 立即/短期
- [ ] 删除临时调试钩子：`ToolCallCard.vue` 的 `window.__TOOL_DEBUG__`（确认工具名修复后）
- [ ] 验证真实 LLM（用户中转站）下工具名、流式、多 turn 完整链路

### 中期（M4/M5 收尾）
- [x] `skill.find` / `skill.installGithub`（GitHub 技能搜索/安装，skills.sh catalog）— 已完成
- [x] `message.stop`（终止生成）— 已完成：私聊 `POST /chatapi/bots/:id/stop` → `agent.cancel({kind:'user'})`；群聊 `POST /chatapi/groups/:id/stop` → 容器编排 + 全部成员 bot agent 一并 cancel。取消后 dsh 发 `turn/end(aborted/user)`，bridge 正常聚合部分内容并发 `done:true` 收尾
- [ ] 群消息 usage 归属（当前群消息 usage 字段为 0）
- [ ] persona 生成插件（chat-persona-gen，流式）
- [ ] 审批交互：`api/respond` 双通道（`ApprovalModal` 数据源）
- [x] LLM trace 面板 — 已完成：`llm-trace.ts` 监听 dsh `llm/stream` waterfall（覆盖全部模型调用），环形缓冲 50 条；`GET/DELETE /chatapi/llm-trace`；usage 求和语义（promptTokens = input + cacheRead + cacheWrite）

### 远期（M6）
- [ ] 数据迁移脚本：旧 SQLite（bots/settings/messages）→ dsh storages + session 日志
- [ ] 正式打包：Rust 侧接 sidecar（node + apps/cli/lib 打进 bundle）
- [ ] 删除旧 `cli/`、`app/`（迁移完成后）
- [ ] 严格读围栏（如需要）：fork `fs-sandbox` 加 `strictRead` 选项

## 运行方式

```bash
# 构建（host + client 两个 face）
cd deepseek-harness
pnpm install --ignore-scripts
pnpm run build

# 仅调试 host
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent
curl http://127.0.0.1:3180/chatapi/bots

# 桌面应用
cd apps/desktop && pnpm tauri dev
```

## 验证脚本（/tmp 临时，可复现）

- `/tmp/fake-llm.mjs` / `/tmp/fence-llm.mjs` / `/tmp/notools-llm.mjs` — OpenAI 兼容流式 fake 服务（9199 端口）
- 冒烟脚本走 curl 直接测端点，无需前端

## 关键依赖版本

- Node（dsh 运行时）+ pnpm workspace
- Vue 3.5.13 + Pinia + Tailwind CSS v4 + Tauri 2
- dsh 内部包（fork，vendor 锁定）
