# 关键坑与排障记录

按「踩坑 → 根因 → 解决」记录，避免重复踩。

## dsh 底座相关

### 1. 自定义持久化事件 resume 失败
- **现象**：`group/*` 自定义事件重启后历史丢失，resume 抛 `SessionFormatUnsupportedError`
- **根因**：`KNOWN_SESSION_EVENT_TYPES` 白名单（生成式文件）不含自定义事件
- **解决**：跑 `pnpm run gen-persistence-catalog` 重新生成收录

### 2. 模块级 inject settings/credentials 启动死锁
- **现象**：chat-bots 永不激活，无错误日志（chat-group pending 等 chatBots）
- **根因**：`settings`/`credentials` 服务激活晚于 chat 插件，模块级 `inject` 声明导致 fiber 永久 pending
- **解决**：inject 数组去掉这两项，改 `ctx.inject(['settings','credentials'], cb)` 动态注入 + `servicesReady` Promise

### 3. 同插件二次 storageDomain.open 报错
- **现象**：`json backend is closed`
- **根因**：json 后端生命周期不支持单插件二次 open
- **解决**：models 表并入 bots domain，单次 open

### 4. profile 需显式依赖被插入插件
- **现象**：`dsh-chat-bots` resolve 失败
- **根因**：pnpm isolated linker 只暴露 profile 的直接依赖
- **解决**：profile package.json 里列出 chat-bots/chat-group/chat-agent 全部依赖

### 5. web bundle 需 host + client 两个 face 都构建
- **现象**：`typert-registry` 产物缺失，boot 报 module not found
- **解决**：`npx tsc -b tsconfig.client.json && npx tsdown --env.DSH_BUILD_FACE client` 补跑 client face

### 6. 表名必须 snake_case
- **现象**：`botSessions` 表初始化报错
- **解决**：改用 `bot_sessions`

### 7. 一个 dsh turn = 一次完整 run
- **现象**：误以为「工具轮 = 一个 turn，文本轮 = 下一个 turn」，导致带工具的回复被吞或拆成多个气泡
- **真相**：工具调用循环都在同一 turn 内，`turn/end reason=completed` 才结束
- **解决**：每个 `turn/end` = run 完结；id 统一 `m-p{promptSeq}`

### 8. usage 字段互斥（缓存命中率 >100%）
- **现象**：缓存命中率 7771%
- **根因**：`inputTokens` 仅非缓存输入，缓存读/写单独计；旧 UI 的 prompt_tokens 是全量输入
- **解决**：`promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens`

### 9. 仓库 AGENTS.md 注入污染聊天
- **现象**：新好友「拿到上一个 Agent 上下文」
- **根因**：bot workspace 在 repo 内，agent-instructions 沿目录向上收集到仓库根 AGENTS.md（16KB）
- **解决**：bundle patch 设 `agent-instructions.maxBytes: 0` + `tool-skill.disabled`

### 10. 自建 fs provider 与内置冲突
- **现象**：注册第二个 `fs` provider 无效/冲突
- **解决**：删自建 `WorkspaceFencedFs`，改接 meta.cwd（内置 SandboxedFileSystem 按 session cwd 围栏）

## 前端相关

### 11. Tauri 禁用 window.confirm
- **现象**：删除模型「没生效」——确认弹窗弹不出来，静默返回 false
- **解决**：用应用内 `ConfirmDialog`

### 12. 工具名丢失
- **现象**：工具名只显示「工具」兜底
- **根因**：`tool.args` 增量帧先建卡（name 空，delta 本身不含工具名），`tool.start` 到达时只补 args 不回填 name
- **解决**：start 到达时 `if (d.name) t.name = d.name`

### 13. 同名好友头像串
- **根因**：6 处组件用 `b.name === conv.name` 反查 bot
- **解决**：统一从会话 id `private:{botId}` 解析 botId 反查

### 14. 一次输出多个气泡
- **根因**：草稿 id `m-p{N}` 与 created id `m-{turn}` 不一致，草稿删不掉 + 正式消息并存
- **解决**：统一 `m-p{promptSeq}`

### 15. Vue watchEffect 未 import
- **现象**：`Can't find variable: watchEffect` + `instance.update is not a function` + `null is not an object (el.__vnode.n2)`
- **根因**：临时调试代码用 watchEffect 但未 import，HMR 缓存旧模块
- **解决**：删除调试代码

### 16. macOS 弹性滚动穿透
- **现象**：UI 被滚出边界
- **根因**：`overscroll-behavior: auto` 默认穿透（与 overflow:hidden 无关）
- **解决**：根容器 + 消息区 + 会话列表加 `overscroll-contain`

### 17. 环境杂项
- **lefthook stale lock**：删 `.git/dsh-lefthook-install.lock` 后重跑 pnpm install
- **端口占用**：旧 chat-agent serve 进程占用 3180 → `pkill -f "profile chat-agent"`
- **IMKCFRunLoopWakeUpReliable**：macOS 输入法系统噪音，无害
- **WS events.mux 断连**：host 重启瞬间的自动重连，聊天走 SSE 不受影响
