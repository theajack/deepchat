/**
 * MCP 服务管理：面向前端 `/chatapi/mcp/*` 的配置 CRUD 与连接测试。
 *
 * 配置持久化在 `$DSH_HOME/mcp/servers.json`，每条记录即一个 mcp-client
 * 插件实例的 config（stdio / streamable-http 二选一）。连接本身不在这层：
 * 写入后调用方（前端）需要让宿主重载（当前实现：追加到配置后通过
 * `ctx.runtime.reload()` 热插拔，见 {@link McpService.syncPlugins}）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 允许的 serverName（与 mcp-client 的 SERVER_NAME_PATTERN 一致） */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** stdio 型服务配置 */
export interface McpStdioConfig {
  transport: 'stdio'
  serverName: string
  command: string
  args: string[]
  env: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number
}

/** streamable-http 型服务配置 */
export interface McpHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs?: number
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig

/** 前端列表项（McpServerInfo 的后端形状） */
export type McpServerRecord = (McpStdioConfig | McpHttpConfig) & {
  id: string
  createdAt: number
  updatedAt: number
}

/** 存储文件形状 */
interface McpStoreFile {
  servers: McpServerRecord[]
}

const EMPTY_STORE: McpStoreFile = { servers: [] }

/**
 * 一个 MCP 服务的连接状态。
 *
 * 由装载方在运行时维护：装载开始 → connecting，插件激活完成 → connected，
 * 激活抛错 → error。没有记录表示尚未装载。
 */
export type McpStatus = 'connecting' | 'connected' | 'error' | 'disconnected'

/** 一个 MCP 服务在列表接口中的视图：服务记录 + 实时状态/工具数/错误信息。 */
export type McpServerView = McpServerRecord & {
  health: McpStatus
  toolCount: number
  error: string
}

/**
 * 各家 MCP 客户端对 transport 的写法 → mcp-client transport 值。
 *
 * 实测见过的写法：`stdio` / `streamable-http` / `streamableHttp`（驼峰）/
 * `http` / `https` / `sse`，以及写在 `type` 或 `transportType` 字段上。
 */
const TRANSPORT_MAP: Record<string, 'stdio' | 'streamable-http'> = {
  stdio: 'stdio',
  'streamable-http': 'streamable-http',
  streamablehttp: 'streamable-http',
  http: 'streamable-http',
  https: 'streamable-http',
  sse: 'streamable-http',
}

/** 支持批量：识别出 `{ mcpServers: { name: cfg } }` 字典，逐条解析 */
export function parseMcpInputs(raw: unknown): McpServerConfig[] {
  if (typeof raw !== 'object' || raw === null) throw new Error('mcp config must be an object')
  const body = raw as Record<string, unknown>

  // 形态零：标准客户端配置 { mcpServers: { <name>: cfg } } —— key 即 serverName。
  // 这是 Cursor / Claude Desktop / Cline 的通用格式，一次可导入多个服务。
  const dict = body.mcpServers
  if (typeof dict === 'object' && dict !== null && !Array.isArray(dict)) {
    const configs: McpServerConfig[] = []
    const problems: string[] = []
    for (const [name, entry] of Object.entries(dict)) {
      if (typeof entry !== 'object' || entry === null) continue
      const cfg = entry as Record<string, unknown>
      // 显式 disabled 的服务不导入（如示例里的 "Figma"）
      if (cfg.disabled === true) continue
      try {
        configs.push(normalizeServer(name, cfg))
      } catch (error: unknown) {
        problems.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // 全部失败时把原因抛给前端，部分失败则导入成功的那些
    if (configs.length === 0) {
      throw new Error(problems.length > 0
        ? `no importable servers in "mcpServers": ${problems.join('; ')}`
        : 'no enabled servers found in "mcpServers"')
    }
    return configs
  }

  return [parseMcpInput(raw)]
}

/** 解析单条配置（表单字段或单个服务对象） */
export function parseMcpInput(raw: unknown): McpServerConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('mcp config must be an object')
  const body = raw as Record<string, unknown>
  const name = firstString(body.serverName, body.name)
  if (name === undefined) {
    throw new Error('mcp config needs a "serverName" (or wrap it as { "mcpServers": { "<name>": {...} } })')
  }
  return normalizeServer(name, body)
}

/** 从 transport / type / transportType 推断，都没有则按 command / url 兜底 */
function inferTransport(body: Record<string, unknown>): 'stdio' | 'streamable-http' {
  for (const key of ['transport', 'type', 'transportType']) {
    const mapped = TRANSPORT_MAP[String(body[key] ?? '').trim().toLowerCase()]
    if (mapped !== undefined) return mapped
  }
  if (typeof body.command === 'string' && body.command.trim() !== '') return 'stdio'
  if (typeof body.url === 'string' && body.url.trim() !== '') return 'streamable-http'
  throw new Error('mcp config needs either a transport/type, or "command" (stdio), or "url" (http)')
}

/** timeout 单位歧义：< 1000 视为秒（60 → 60000ms），否则视为毫秒 */
function toTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1000 ? raw * 1000 : raw
  }
  return undefined
}

function normalizeServer(rawName: string, body: Record<string, unknown>): McpServerConfig {
  const serverName = rawName.trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`serverName "${serverName}" must match ${SERVER_NAME_PATTERN.toString()}`)
  }
  const transport = inferTransport(body)
  const timeoutMs = toTimeoutMs(body.timeout)

  if (transport === 'stdio') {
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (command === '') throw new Error('stdio transport requires "command"')
    return {
      transport: 'stdio',
      serverName,
      command,
      args: toStringArray(body.args),
      env: toStringMap(body.env),
      ...(typeof body.cwd === 'string' && body.cwd !== '' ? { cwd: body.cwd } : {}),
      ...(timeoutMs !== undefined ? { toolCallTimeoutMs: timeoutMs } : {}),
    }
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (url === '') throw new Error('http transport requires "url"')
  return {
    transport: 'streamable-http',
    serverName,
    url,
    headers: toStringMap(body.headers),
    ...(timeoutMs !== undefined ? { toolCallTimeoutMs: timeoutMs } : {}),
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

function toStringMap(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/** 配置文件路径：$DSH_HOME/mcp/servers.json */
function serversFilePath(): string {
  const home = process.env.DSH_HOME ?? ''
  if (home === '') throw new Error('DSH_HOME is not set')
  return join(home, 'mcp', 'servers.json')
}

/** 读取全部已配置服务（供宿主启动时装载） */
export async function readMcpServers(): Promise<McpServerRecord[]> {
  return (await readStore()).servers
}

async function readStore(): Promise<McpStoreFile> {
  try {
    const text = await readFile(serversFilePath(), 'utf8')
    const parsed = JSON.parse(text) as Partial<McpStoreFile>
    if (!Array.isArray(parsed.servers)) return { ...EMPTY_STORE }
    return { servers: parsed.servers.filter((s): s is McpServerRecord => typeof s?.serverName === 'string') }
  } catch {
    return { ...EMPTY_STORE }
  }
}

async function writeStore(store: McpStoreFile): Promise<void> {
  const file = serversFilePath()
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

/**
 * MCP 服务管理 API。
 *
 * 前端有两种添加方式：结构化表单字段，或整体 JSON（标准 mcp-client
 * config，如 `{"transport":"stdio","serverName":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem"]}`），
 * 两种都由 {@link parseMcpInput} 归一化。
 */
export class McpService {
  constructor(private readonly ctx: Context) {}

  /**
   * 列出已配置的服务。
   *
   * `status` 是装载方（ChatBots）维护的实时连接状态；没提供的服务（比如
   * 还没轮到装载）退回按工具数推断，保持旧行为。
   */
  async list(status?: ReadonlyMap<string, McpStatus>): Promise<McpServerView[]> {
    const store = await readStore()
    const schemas = this.ctx.tools.schemas()
    return store.servers.map((server) => {
      const prefix = `mcp__${server.serverName}__`
      const tools = schemas.filter(schema => schema.name.startsWith(prefix))
      const live = status?.get(server.serverName)
      return {
        ...server,
        // 前端列表按 `name` 显示。serverName 永远存在（parseMcpInput 已
        // 校验），没有它就是历史脏数据 —— 用 serverName 兜底，绝不让
        // `undefined` 漏到 UI。
        name: server.serverName,
        health: live ?? (tools.length > 0 ? 'connected' : 'disconnected'),
        toolCount: tools.length,
        error: '',
      }
    })
  }

  /**
   * 新增。
   *
   * body 可为：① 单个服务对象 / 表单字段；② `{ mcpServers: { name: cfg } }`
   * 字典（一次导入多个，重名或非法条目跳过，全部失败才报错）。
   */
  async add(raw: unknown): Promise<{ added: McpServerRecord[]; skipped: string[] }> {
    const configs = parseMcpInputs(raw)
    const store = await readStore()
    const now = Date.now()
    const added: McpServerRecord[] = []
    const skipped: string[] = []

    for (const config of configs) {
      if (store.servers.some(s => s.serverName === config.serverName)) {
        skipped.push(`${config.serverName} (already exists)`)
        continue
      }
      const record: McpServerRecord = {
        ...config,
        id: `mcp-${config.serverName}`,
        createdAt: now,
        updatedAt: now,
      }
      store.servers.push(record)
      added.push(record)
    }

    if (added.length === 0) throw new Error(`nothing to add: ${skipped.join('; ')}`)
    // 只落盘配置；插件实例由 ChatBots 在运行时 ctx.plugin() 装载（见其
    // mountMcpServer），所以这里不再写任何 patch 文件。
    await writeStore(store)
    return { added, skipped }
  }

  /**
   * 更新。
   *
   * serverName 是身份标识（工具命名空间 `mcp__<name>__` 的来源），编辑时
   * **固定不变**：一旦允许改，好友配置里已勾选的 enabledMcpServers 引用会
   * 全部失效。前端在编辑面板里把它标为只读。
   */
  async update(id: string, raw: unknown): Promise<McpServerRecord> {
    const config = parseMcpInput(raw)
    const store = await readStore()
    const index = store.servers.findIndex(s => s.id === id)
    if (index === -1) throw new Error(`mcp server "${id}" not found`)
    const previous = store.servers[index]
    const now = Date.now()
    const serverName = previous?.serverName ?? config.serverName
    const record: McpServerRecord = {
      ...config,
      serverName,
      id: previous?.id ?? `mcp-${serverName}`,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    store.servers[index] = record
    await writeStore(store)
    return record
  }

  /** 删除；返回被删服务的 serverName 供调用方卸载实例 */
  async remove(id: string): Promise<string> {
    const store = await readStore()
    const target = store.servers.find(s => s.id === id)
    if (target === undefined) throw new Error(`mcp server "${id}" not found`)
    const next = store.servers.filter(s => s.id !== id)
    await writeStore({ servers: next })
    return target.serverName
  }

  /**
   * 连接探测：查该服务当前已注册的工具。
   *
   * 注意这不是"发起一次新握手"——那需要重建完整客户端实例。这里读的是
   * 全局工具注册表的快照，反映的是插件当前的连接状态：
   *   ok        → 已连上并注册了工具
   *   no_tools  → 一个工具都没有（可能还在启动/重连，也可能这个服务
   *               本身就不暴露工具）；文案交给前端本地化，后端不写死英文
   */
  async test(id: string): Promise<{
    ok: boolean
    code: 'ok' | 'no_tools'
    tools: Array<{ name: string; description?: string }>
    error: string
  }> {
    const store = await readStore()
    const server = store.servers.find(s => s.id === id)
    if (server === undefined) throw new Error(`mcp server "${id}" not found`)
    const prefix = `mcp__${server.serverName}__`
    const tools = this.ctx.tools.schemas()
      .filter(schema => schema.name.startsWith(prefix))
      .map(schema => ({ name: schema.name, description: schema.description }))
    return tools.length > 0
      ? { ok: true, code: 'ok', tools, error: '' }
      : { ok: false, code: 'no_tools', tools: [], error: '' }
  }
}
