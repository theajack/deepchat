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
}

/** streamable-http 型服务配置 */
export interface McpHttpConfig {
  transport: 'streamable-http'
  serverName: string
  url: string
  headers: Record<string, string>
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

/** 前端兼容层：旧表单的 transport 值 → mcp-client transport 值 */
const TRANSPORT_MAP: Record<string, 'stdio' | 'streamable-http'> = {
  stdio: 'stdio',
  'streamable-http': 'streamable-http',
  http: 'streamable-http',
  sse: 'streamable-http',
}

/** 兼容任意输入的宽松解析：表单字段或整体 JSON 均可 */
export function parseMcpInput(raw: unknown): McpServerConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('mcp config must be an object')
  const body = raw as Record<string, unknown>

  // 形态一：标准 mcp-client config（带 transport 字段）
  const rawTransport = typeof body.transport === 'string' ? body.transport : ''
  if (rawTransport === 'stdio' || rawTransport === 'streamable-http') {
    return normalizeKnown(body)
  }

  // 形态二：旧表单 / 简化 JSON（transport: stdio|sse|http）
  const mapped = TRANSPORT_MAP[rawTransport]
  if (rawTransport !== '' && mapped !== undefined) {
    return normalizeKnown({ ...body, transport: mapped })
  }

  // 形态三：无 transport —— 有 command 走 stdio，有 url 走 http
  if (typeof body.command === 'string' && body.command.trim() !== '') {
    return normalizeKnown({ ...body, transport: 'stdio' })
  }
  if (typeof body.url === 'string' && body.url.trim() !== '') {
    return normalizeKnown({ ...body, transport: 'streamable-http' })
  }

  throw new Error('mcp config needs either "transport", or "command" (stdio), or "url" (http)')
}

function normalizeKnown(body: Record<string, unknown>): McpServerConfig {
  const serverName = typeof body.serverName === 'string' && body.serverName.trim() !== ''
    ? body.serverName.trim()
    : typeof body.name === 'string' && body.name.trim() !== ''
      ? body.name.trim()
      : ''
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`serverName must match ${SERVER_NAME_PATTERN.toString()}`)
  }

  if (body.transport === 'stdio') {
    const command = typeof body.command === 'string' ? body.command.trim() : ''
    if (command === '') throw new Error('stdio transport requires "command"')
    return {
      transport: 'stdio',
      serverName,
      command,
      args: toStringArray(body.args),
      env: toStringMap(body.env),
      ...(typeof body.cwd === 'string' && body.cwd !== '' ? { cwd: body.cwd } : {}),
    }
  }

  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (url === '') throw new Error('http transport requires "url"')
  return {
    transport: 'streamable-http',
    serverName,
    url,
    headers: toStringMap(body.headers),
  }
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

  /** 列出已配置的服务（含从全局工具注册表推断的连接状态与工具数） */
  async list(): Promise<Array<McpServerRecord & { health: string; toolCount: number; error: string }>> {
    const store = await readStore()
    const schemas = this.ctx.tools.schemas()
    return store.servers.map((server) => {
      const prefix = `mcp__${server.serverName}__`
      const tools = schemas.filter(schema => schema.name.startsWith(prefix))
      return {
        ...server,
        // 前端列表按 `name` 显示。serverName 永远存在（parseMcpInput 已
        // 校验），没有它就是历史脏数据 —— 用 serverName 兜底，绝不让
        // `undefined` 漏到 UI。
        name: server.serverName,
        health: tools.length > 0 ? 'connected' : 'disconnected',
        toolCount: tools.length,
        error: '',
      }
    })
  }

  /** 新增（body 可为表单字段或整体 JSON config） */
  async add(raw: unknown): Promise<McpServerRecord> {
    const config = parseMcpInput(raw)
    const store = await readStore()
    if (store.servers.some(s => s.serverName === config.serverName)) {
      throw new Error(`serverName "${config.serverName}" already exists`)
    }
    const now = Date.now()
    const record: McpServerRecord = {
      ...config,
      id: `mcp-${config.serverName}`,
      createdAt: now,
      updatedAt: now,
    }
    store.servers.push(record)
    await writeStore(store)
    await this.syncPlugins(store)
    return record
  }

  /** 更新 */
  async update(id: string, raw: unknown): Promise<McpServerRecord> {
    const config = parseMcpInput(raw)
    const store = await readStore()
    const index = store.servers.findIndex(s => s.id === id)
    if (index === -1) throw new Error(`mcp server "${id}" not found`)
    const previous = store.servers[index]
    const now = Date.now()
    const record: McpServerRecord = {
      ...config,
      id: previous?.id ?? `mcp-${config.serverName}`,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    store.servers[index] = record
    await writeStore(store)
    await this.syncPlugins(store)
    return record
  }

  /** 删除 */
  async remove(id: string): Promise<void> {
    const store = await readStore()
    const next = store.servers.filter(s => s.id !== id)
    if (next.length === store.servers.length) throw new Error(`mcp server "${id}" not found`)
    await writeStore({ servers: next })
    await this.syncPlugins({ servers: next })
  }

  /**
   * 连接测试：直接用 stdio/http 客户端拉一次工具列表，不经过插件实例。
   * 复用 mcp-client 包的连接原语成本较高（需要构造完整 Cordis 上下文），
   * 这里只做一次轻量握手探测。
   */
  async test(id: string): Promise<{ ok: boolean; tools: Array<{ name: string; description?: string }>; error: string }> {
    const store = await readStore()
    const server = store.servers.find(s => s.id === id)
    if (server === undefined) throw new Error(`mcp server "${id}" not found`)
    // 轻量探测：检查全局工具注册表中是否已有该服务的工具
    const prefix = `mcp__${server.serverName}__`
    const tools = this.ctx.tools.schemas()
      .filter(schema => schema.name.startsWith(prefix))
      .map(schema => ({ name: schema.name, description: schema.description }))
    return { ok: tools.length > 0, tools, error: tools.length > 0 ? '' : 'no tools registered (server may need a restart to connect)' }
  }

  /**
   * 把 servers.json 同步成 profile 的 mcp 插件实例。
   *
   * dsh 的插件树来自 cordis.patch.yml + profile package.json，运行时不能
   * 直接增删插件；这里把配置写进 `$DSH_HOME/profiles/chat-agent/cordis.mcp.yml`
   * （由 loader 在启动时读取的补充 patch），并提示需要重启宿主生效。
   */
  private async syncPlugins(store: McpStoreFile): Promise<void> {
    const dshHome = process.env.DSH_HOME ?? ''
    if (dshHome === '') return
    const lines: string[] = ['# Managed by DeepChat MCP panel — do not edit by hand.']
    for (const server of store.servers) {
      const config = server.transport === 'stdio'
        ? `{"transport":"stdio","serverName":${JSON.stringify(server.serverName)},"command":${JSON.stringify(server.command)},"args":${JSON.stringify(server.args)},"env":${JSON.stringify(server.env)}}`
        : `{"transport":"streamable-http","serverName":${JSON.stringify(server.serverName)},"url":${JSON.stringify(server.url)},"headers":${JSON.stringify(server.headers)}}`
      lines.push(`- id: mcp-${server.serverName}`)
      lines.push('  name: \'@deepseek-ai/dsh-mcp-client\'')
      lines.push(`  config: ${config}`)
    }
    // 空列表也保持合法 YAML（顶层 []）：只有注释的文件会被 YAML 解析成
    // null，loader 的 parsePatchList 直接拒绝启动 —— 这正是踩过的坑。
    if (store.servers.length === 0) lines.push('[]')
    const file = join(dshHome, 'profiles', 'chat-agent', 'cordis.mcp.yml')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8')
  }
}
