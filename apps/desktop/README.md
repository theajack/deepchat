# DeepChat Desktop（dsh 底座版）

原 chat-agent `app/`（Tauri 2 + Vue 3 + Pinia + Tailwind 4）平移而来，
后端从「spawn `chat-agent serve` 子进程 + stdin/stdout JSON Lines IPC」
切换为「spawn `dsh --profile chat-agent` 宿主进程 + HTTP/WS」。

## 架构

```text
Tauri webview (Vue UI)
  │  fetch (tauri-plugin-http, 免 CORS)      WS /api/events.mux
  ▼                                            ▼
dsh host (127.0.0.1:3180, --profile chat-agent)
  ├── /api/*        标准一元 RPC（llm.providers、credentials、session.* …）
  └── /chatapi/*    业务 RPC（chat-bots / chat-group 插件注册）
        /chatapi/bots[/:id][/send|/history]
        /chatapi/groups[/:id][/send|/history]
```

- `src/services/transport/dsh.ts`：HTTP（plugin-http，浏览器回退 fetch）+ WS 订阅
- `src/services/ipc.ts`：`DshTransport` 实现 `IpcTransport` 接口，把旧方法名
  （`bot.list` / `message.send` …）映射到新端点，stores 与视图层不改
- `src-tauri/src/lib.rs`：spawn dsh（dev：`node apps/cli/lib/bin.js --profile chat-agent`；
  可用 `DEEPCHAT_DSH_CMD` 覆盖）、端口就绪探测（`dsh.ready` 事件）、保留浏览器 Tab 控制

## 开发

```bash
# 1. 构建仓库（含 chat 插件与 dsh CLI；host + client 两个 face）
cd <repo-root>
pnpm install --ignore-scripts
pnpm run build

# 2. profile 已就位：.dsh-home/profiles/chat-agent（仓库内 DSH_HOME，
#    已 gitignore；bundle 与 chat 插件通过 workspace 链接解析，
#    见 pnpm-workspace.yaml 的 .dsh-home/profiles/* 条目）
#    如需重建：
#    mkdir -p .dsh-home/profiles/chat-agent  # 写入 package.json：
#    # { "dependencies": { "@deepseek-ai/dsh-base": "workspace:^",
#    #     "@deepseek-ai/dsh-chat-agent": "workspace:^",
#    #     "@deepseek-ai/dsh-chat-bots": "workspace:^",
#    #     "@deepseek-ai/dsh-chat-group": "workspace:^" },
#    #   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-chat-agent"] } } }
#    # 再执行 pnpm install --ignore-scripts

# 3. 启动桌面应用（Rust 侧自动 spawn dsh，DSH_HOME 指向 repo/.dsh-home）
cd apps/desktop
pnpm install
pnpm tauri dev

# 或仅调试 host（不启动桌面应用）：
DSH_HOME=$PWD/.dsh-home node apps/cli/lib/bin.js --profile chat-agent
curl http://127.0.0.1:3180/chatapi/bots
```

环境变量：
- `DEEPCHAT_DSH_CMD`：完整启动命令覆盖（如 `"node /abs/path/bin.js"`）
- `VITE_DSH_BASE` / `window.__DSH_BASE__`：dsh host 地址（默认 `http://127.0.0.1:3180`）

## 迁移状态（对照 plan/dsh-migration.md 里程碑）

| 能力 | 状态 |
|---|---|
| bot CRUD（/chatapi/bots） | ✅ M1 |
| 私聊发送/历史（bot 持久会话） | ✅ M1（无流式） |
| 群聊创建/成员/发送/历史（触发引擎在 host 侧） | ✅ M1（无流式） |
| 会话列表/未读/last_message 聚合 | ⚠️ 简化实现（M2 优化） |
| 模型列表 | ⚠️ /api/llm.providers 映射（M2 接 credentials 配置 UI） |
| 设置 | ⚠️ localStorage 桥（M2 迁 dsh settings/credentials） |
| 流式输出 / typing（message.stream、bot.typing） | ❌ M3：WS 事件 → 旧事件形状翻译 |
| 审批 UI（/api/respond） | ❌ M5 |
| persona 生成 | ❌ M4（chat-persona-gen 插件） |
| 工具调用卡片 / LLM trace | ❌ M5 |
| 消息刷新 | 手动（M3 起由 mux 事件驱动） |
