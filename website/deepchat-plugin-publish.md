# DeepChat 插件发布与安装

DeepChat 以一个 dsh 组合包（bundle）的形式分发：一个标准 npm 包，内含一份 Cordis 配置补丁（`cordis.patch.yml`）。用户用 `dsh plugin add` 把它装进自己的 profile，启动后即获得完整的聊天后端——存储栈、HTTP/API 传输层，以及机器人注册表与群聊编排。

本教程覆盖两件事：维护者如何发布 DeepChat，用户如何把它装进已有的 dsh。组合包的底层机制以[发布组合包](../docs/user/develop/basic/publish.zh.md)为准，本文只写 DeepChat 的具体操作。

## 前置条件

发布方需要 Node.js 与 pnpm、一个可发布到公共源的 npm 账号，以及对目标 scope 的发布权限。用户方需要已安装的 `dsh` CLI。

`dsh plugin --profile <name> <args...>` 在 profile 目录内转发给 pnpm，因此所有 pnpm 子命令都可用。

## 发布前检查清单

组合包靠三处声明生效，缺任何一处，用户装完都不会激活任何层。

| 检查项 | 位置 | 要求 |
|---|---|---|
| bundle 声明 | `package.json` 的 `dsh.bundle.patch` | 指向 `./cordis.patch.yml` |
| 产物白名单 | `package.json` 的 `files` | 必须含 `lib/index.js`、`cordis.patch.yml`、`lib/types/**/*.d.ts` |
| 补丁导出 | `package.json` 的 `exports` | 必须暴露 `./cordis.patch.yml` |
| 包名 scope | `package.json` 的 `name` | `@deepseek-ai` 为官方 scope，第三方发布需改用自己的 scope |
| 版本号 | `package.json` 的 `version` | `0.1.1-rc.2` 这类预发布版本需转为正式版本 |
| 构建产物 | `lib/` | 必须已存在；若缺失，在仓库根跑 `pnpm run build:lib:host` 全量生成 |

`dsh plugin` 会为缺少 `dsh.bundle` 声明的包打印警告，并把它当作普通依赖安装，不激活任何层。

## 打包

这个包**没有也不需要 `build` 脚本**。它的 `src/index.ts` 只有一个 `export {}`，源码注释即写明 `this module carries no runtime API`——包的全部实质是 `cordis.patch.yml`。`lib/index.js` 的 11 字节 `export {};` 是正确产物，不是构建失败。

本仓库的构建是集中式的：各包不自带 `build`，`tsc` 与 `tsdown` 由根脚本统一驱动（`packages/chat/chat-agent` 登记在 `tsconfig.host.json` 中）。因此不要按包逐个构建。

```bash
cd packages/chat/chat-agent

# 直接打包
pnpm pack --pack-destination /tmp
```

只有修改了 `src/` 才需要重新生成产物，此时在**仓库根**执行全量构建（`pnpm run build:lib:host`），而不是在包目录内跑 `build`：

```bash
pnpm --filter @deepseek-ai/dsh-chat-agent build   # 会报 ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT
```

检查 tarball 内容。缺少 `cordis.patch.yml` 是最常见的失败原因——包能装上，但没有任何层生效：

```bash
tar -tzf /tmp/deepseek-ai-dsh-chat-agent-*.tgz
```

预期输出 `package/cordis.patch.yml`、`package/lib/index.js`、`package/lib/types/index.d.ts`、`package/package.json`、`package/LICENSE`。

## 发布到 npm

发布前把 `name` 改成自己的 scope（例如 `@<your-scope>/dsh-deepchat`），并把 `version` 转为正式版本。`dependencies` 里的 `workspace:^` 协议由 pnpm 在发布时替换为实际版本号，无需手工改写。

```bash
npm publish --access public
```

## 用户安装

`dsh plugin` 负责创建和维护 profile manifest，用户不需要手写 bundles 列表。

```bash
# 从 npm 安装
dsh plugin --profile <profile> add @<your-scope>/dsh-deepchat

# 从本地 tarball 安装
dsh plugin --profile <profile> add ./dsh-deepchat-1.0.0.tgz
```

安装会在 profile 的 `package.json` 中追加依赖，并把该包登记进 `dsh.profile.bundles`。

## 验证层已激活

`--dump-config` 只打印组合结果，不启动宿主。输出中出现该包的层，说明补丁已被读取：

```bash
dsh --profile <profile> --dump-config
```

在输出中查找形如 `# == @<your-scope>/dsh-deepchat` 的层标记。没有这一段，说明包的 `files` 或 `dsh.bundle` 声明有问题。

确认后正常启动：

```bash
dsh --profile <profile>
```

聊天后端监听 `127.0.0.1:3180`，Tauri 桌面客户端通过回环地址连接它。

## 卸载

```bash
dsh plugin --profile <profile> remove @<your-scope>/dsh-deepchat
```

该命令同时移除依赖和对应的层。

## 三种分发方式

| 方式 | 用户命令 | 用户侧是否需授权构建 |
|---|---|---|
| npm 发布 | `dsh plugin add @<your-scope>/dsh-deepchat` | 否，装的是预构建代码 |
| tarball | `dsh plugin add ./dsh-deepchat-1.0.0.tgz` | 否 |
| GitHub 源码 | `dsh plugin add github:<you>/<repo>` | 是，需在 profile 的 `package.json` 写 `pnpm.onlyBuiltDependencies.allowBuilds` |

优先选 npm 或 tarball。GitHub 方式下，pnpm 10 及以上默认拒绝执行 git 依赖的 `prepare` 脚本，用户首次 `add` 会失败，直到手动加白名单。

## 已知限制

DeepChat 的补丁只引用插件包，不携带它们的代码。以下几点决定了发布形态，动手前请先决策。

**定制能力位于被引用的包内。** `fetch` 工具、人设生成端点 `/chatapi/persona/generate`、以及 llm-trace 的图片与上传追踪，都实现在 `@deepseek-ai/dsh-chat-bots` 中，不在 bundle 包内。用户安装 npm 包后拿到的是该包的官方发布版本，不包含这些能力。

**两处启动故障修复同样位于被引用包内。** `apply()` 的异步等待修复分布在 `@deepseek-ai/dsh-chat-bots` 与 `@deepseek-ai/dsh-chat-group`，孤儿锁回收位于 `@deepseek-ai/dsh-atomic-write`。引用官方版本时，用户会遇到 `1 entry did not activate` 与 `timed out waiting for the writer lock` 两个启动故障。

由此产生三条路径，按推荐顺序：

1. **外置能力 + 向上游提修复。** 把人设生成端点搬进 bundle 自身：它只依赖 `webServer` 与 `llm` 两个服务，补丁中均已挂载，通用处理模型可通过 `chat-bots` 现有的 HTTP 端点 `/chatapi/models/group-judge` 获取。两处启动故障无法外置，需向上游提 PR，但它们对所有 dsh 用户都有价值。
2. **Fork 被引用包。** 把 `dsh-chat-bots`、`dsh-chat-group`、`dsh-atomic-write` 以自有 scope 发布，并让补丁指向 fork 版本。可立即发布，代价是持续承担与上游的合并成本。
3. **全量提 PR。** 最干净，但发布节奏取决于上游评审。

补丁是配置而非代码，且**替换**目标行的整个 `config`，不做深度合并。因此补丁中每一行都必须重述它拥有的全部键，这也意味着无法通过补丁为上游插件补加代码级行为。
