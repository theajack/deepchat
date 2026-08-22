/**
 * The chat-agent bot registry: durable companion records over a storage
 * domain, lazy per-bot agents whose persona rides a scoped prompt section,
 * and the `/chatapi/bots` HTTP surface the desktop UI consumes.
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls in the `webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: pulls in the `tools` Context augmentation.
import type {} from '@deepseek-ai/dsh-tools'
// Side-effect type import: pulls in the `settings`/`credentials` augmentations.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { type ModelRecord, modelRecordSchema, ModelStore, removeRoute, routeIdFor, syncRoute } from './models.ts'
import { renderPrivateHistory, translateSessionEvent } from './bridge.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { BotCreateInput, BotRecord, BotUpdatePatch } from './types.ts'
import { botRecordSchema } from './schema.ts'

export type { BotCreateInput, BotRecord, BotUpdatePatch, TriggerConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'chat-bots'

/** Agent registry, tool/skill registries, settings, credentials, storage domain facility, and the HTTP carrier are required. */
export const inject = ['agents', 'tools', 'skills', 'storageDomain', 'webServer']

/** Plugin config (all deployment-tunable values carry defaults). */
export interface Config {
  /** Maximum retained bots; a creation past the cap is a `bad-request`. */
  readonly maxBots?: number
  /** Default trigger policy for bots created without one. */
  readonly defaultTrigger?: { activeRate: number; keywords: string[]; cooldownSeconds: number }
}

const DEFAULT_MAX_BOTS = 1000
const DEFAULT_TRIGGER: NonNullable<Config['defaultTrigger']> = {
  activeRate: 0.3, keywords: [], cooldownSeconds: 60,
}

/** Front-end model shape (snake_case, mirroring the legacy `ai_models` row). */
function toFrontModel(record: ModelRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: record.name,
    provider: record.provider,
    base_url: record.baseUrl,
    api_key: record.apiKey,
    model_name: record.modelName,
    tool_use: record.toolUse,
    image_input: record.imageInput,
    reasoning_mode: record.reasoningMode,
    custom_protocol: record.customProtocol,
    input_ctx: record.inputCtx,
    output_ctx: record.outputCtx,
    route_id: routeIdFor(record.id),
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  }
}

function parseModelInput(body: Record<string, unknown>, base?: ModelRecord): Omit<ModelRecord, 'id' | 'createdAt' | 'updatedAt'> {
  const str = (key: string, fallback: string): string => (typeof body[key] === 'string' ? body[key] as string : fallback)
  const bool = (key: string, fallback: boolean): boolean => {
    const value = body[key]
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    return fallback
  }
  return {
    name: str('name', base?.name ?? ''),
    provider: str('provider', base?.provider ?? 'custom'),
    baseUrl: str('base_url', base?.baseUrl ?? ''),
    apiKey: body.api_key === undefined ? base?.apiKey ?? '' : str('api_key', ''),
    modelName: str('model_name', base?.modelName ?? ''),
    toolUse: bool('tool_use', base?.toolUse ?? true),
    imageInput: bool('image_input', base?.imageInput ?? false),
    reasoningMode: bool('reasoning_mode', base?.reasoningMode ?? false),
    customProtocol: bool('custom_protocol', base?.customProtocol ?? false),
    inputCtx: str('input_ctx', base?.inputCtx ?? ''),
    outputCtx: str('output_ctx', base?.outputCtx ?? ''),
  }
}

export const Config: z<Config> = z.object({
  maxBots: z.natural().default(DEFAULT_MAX_BOTS),
  defaultTrigger: z.object({
    activeRate: z.percent().default(0.3),
    keywords: z.array(z.string()).default([]),
    cooldownSeconds: z.natural().default(60),
  }).default(DEFAULT_TRIGGER),
})

/** The durable bot-record storage domain. */
const botsDomainSpec = defineDomain({
  name: 'chat_bots',
  version: 1,
  tables: {
    bots: domainTable<string, BotRecord>(botRecordSchema),
    // Models live in the same domain: the json storage backend does not
    // survive a second `storageDomain.open` from one plugin, so all chat-bots
    // tables share a single domain handle.
    models: domainTable<string, ModelRecord>(modelRecordSchema),
  },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatBots: ChatBots
  }
}

/** The bot registry service. */
export class ChatBots extends Service {
  private domain: Domain<typeof botsDomainSpec> | undefined

  private models: ModelStore | undefined

  /** Live agent handles by bot id; disposal removes the entry. */
  private readonly handles = new Map<string, AgentHandle>()

  /** Persona-section disposers by bot id, for live persona edits. */
  private readonly personaDispose = new Map<string, () => void>()

  /**
   * Resolves once the late-activating `settings`/`credentials` services are
   * mounted. Declaring them in the module-level `inject` array deadlocks the
   * boot order (they activate after the chat plugins), so we request them
   * dynamically and await this promise inside the model handlers.
   */
  private readonly servicesReady = new Promise<Context>((resolve) => {
    this.ctx.inject(['settings', 'credentials'], servicesCtx => resolve(servicesCtx))
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'chatBots')
  }

  /** The opened domain; throws before `start()` completes. */
  private get store(): Domain<typeof botsDomainSpec> {
    if (this.domain === undefined) throw new Error('chat-bots: domain not open')
    return this.domain
  }

  async [Service.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(botsDomainSpec)
    this.ctx.effect(() => () => {
      void this.domain?.close()
      this.domain = undefined
    }, 'chat-bots domain')
    this.models = new ModelStore(this.domain)
    // 一次性回填：为缺少工作目录的旧好友记录补建 workspace/agents/{id}
    const bots = this.domain.table('bots')
    for (const [id, bot] of bots.entries()) {
      if (bot.workspaceDir !== undefined) continue
      const workspaceDir = join(resolveDshHome(), 'workspace', 'agents', id)
      await mkdir(workspaceDir, { recursive: true })
      await bots.put(id, { ...bot, workspaceDir, updatedAt: Date.now() })
    }
    this.registerHttp()
    // Private-chat event bridge: translate bot session events into the legacy
    // UI shapes and fan them out over the SSE channel.
    this.ctx.on('session/event', (session, event) => {
      const bot = this.botBySessionId(session.id)
      if (bot === undefined) return
      translateSessionEvent(session, event, {
        conversationId: `private:${bot.id}`,
        botId: bot.id,
        botName: bot.name,
        emitFinal: true,
        conversation: {
          id: `private:${bot.id}`,
          type: 'private',
          name: bot.name,
          avatar: bot.avatar ?? null,
          introduction: '',
          unread_count: 0,
          created_at: bot.createdAt,
        },
      }, this.broadcast.bind(this))
    })
  }

  /** The bot record owning one session id, if any (private-chat sessions only). */
  private botBySessionId(sessionId: SessionId): BotRecord | undefined {
    return this.list().find(bot => bot.sessionId === sessionId)
  }

  // ── SSE event fan-out ─────────────────────────────────────────────────────

  private readonly sseClients = new Set<ServerResponse>()

  /** Push one legacy-shaped event frame to every connected desktop client. */
  broadcast(event: string, data: unknown): void {
    const payload = `data: ${JSON.stringify({ event, data })}\n\n`
    for (const client of this.sseClients) {
      try {
        client.write(payload)
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  private registerSseEndpoint(): void {
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/events',
      handler: (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'method not allowed' }))
          return
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        })
        res.write(':ok\n\n')
        this.sseClients.add(res)
        req.on('close', () => {
          this.sseClients.delete(res)
        })
      },
    })
  }

  /** Every bot record, newest first. */
  list(): BotRecord[] {
    return [...this.store.table('bots').entries()]
      .map(([, record]) => record)
      .filter(record => record.deletedAt === undefined)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** All bot records including soft-deleted ones (for history projections). */
  listAll(): BotRecord[] {
    return [...this.store.table('bots').entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** One bot record, or undefined. */
  get(id: string): BotRecord | undefined {
    return this.store.table('bots').get(id)
  }

  /** Create a bot and mint its persistent session identity. */
  async create(input: BotCreateInput): Promise<BotRecord> {
    const trigger = input.trigger ?? this.config.defaultTrigger ?? DEFAULT_TRIGGER
    const maxBots = this.config.maxBots ?? DEFAULT_MAX_BOTS
    if (this.store.table('bots').size >= maxBots) {
      throw new Error(`chat-bots: bot cap (${String(maxBots)}) reached`)
    }
    const now = Date.now()
    const id = `bot-${randomUUID()}`
    // 每个好友固定工作目录：$DSH_HOME/workspace/agents/{uid}（对齐旧版逻辑）
    const workspaceDir = input.workspaceDir ?? join(resolveDshHome(), 'workspace', 'agents', id)
    const record: BotRecord = {
      ...input,
      workspaceDir,
      trigger,
      id,
      sessionId: `session-${randomUUID()}` as SessionId,
      createdAt: now,
      updatedAt: now,
    }
    await mkdir(workspaceDir, { recursive: true })
    await this.store.table('bots').put(record.id, record)
    return record
  }

  /** Patch a bot; persona edits apply live, model edits rebuild the agent. */
  async update(id: string, patch: BotUpdatePatch): Promise<BotRecord> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`chat-bots: bot "${id}" not found`)
    const next: BotRecord = {
      ...current,
      ...patch,
      trigger: patch.trigger ?? current.trigger,
      updatedAt: Date.now(),
    }
    await this.store.table('bots').put(id, next)

    const modelChanged = patch.provider !== undefined || patch.model !== undefined
    const personaChanged = patch.persona !== undefined && patch.persona !== current.persona

    if (this.handles.has(id)) {
      if (modelChanged) {
        // Model/provider live in AgentOptions, fixed at creation: rebuild on
        // the same durable session identity (resume keeps the bot's memory).
        await this.rebuildAgent(id)
      } else if (personaChanged) {
        const handle = this.handles.get(id)
        if (handle !== undefined) this.applyPersona(handle.agent, next)
      }
    }
    return next
  }

  /** Soft-delete a bot: keep its record (with session history) but retire it. */
  async remove(id: string): Promise<void> {
    const bot = this.get(id)
    if (bot === undefined) return
    const handle = this.handles.get(id)
    if (handle !== undefined) {
      this.handles.delete(id)
      this.personaDispose.delete(id)
      await handle.dispose()
    }
    await this.store.table('bots').put(id, { ...bot, deletedAt: Date.now(), updatedAt: Date.now() })
  }

  /** Reset a bot's chat memory: fresh session id, old log files removed. */
  async clear(id: string): Promise<void> {
    const bot = this.get(id)
    if (bot === undefined) throw new Error(`chat-bots: bot "${id}" not found`)
    const handle = this.handles.get(id)
    if (handle !== undefined) {
      this.handles.delete(id)
      this.personaDispose.delete(id)
      await handle.dispose()
    }
    const sessionId = `session-${randomUUID()}` as SessionId
    await this.store.table('bots').put(id, { ...bot, sessionId, updatedAt: Date.now() })
    await this.removeSessionLogs(bot.sessionId)
  }

  /** Remove one session's log directories under $DSH_HOME/sessions. */
  private async removeSessionLogs(sessionId: SessionId): Promise<void> {
    const sessionsRoot = join(resolveDshHome(), 'sessions')
    try {
      for (const dir of await readdir(sessionsRoot)) {
        const target = join(sessionsRoot, dir, sessionId)
        try {
          const stat = await access(target)
          void stat
          await rm(target, { recursive: true, force: true })
        } catch {
          // 该 cwd 分组下无此会话
        }
      }
    } catch {
      // sessions 根不存在则无事可做
    }
  }

  /**
   * The live agent for a bot, creating (or resuming its persisted session)
   * on first use. The agent's persona is a scoped prompt section, so a live
   * re-registration swaps personas without rebuilding the agent.
   */
  async ensureAgent(id: string): Promise<Agent> {
    const existing = this.handles.get(id)
    if (existing !== undefined) return existing.agent
    const bot = this.get(id)
    if (bot === undefined) throw new Error(`chat-bots: bot "${id}" not found`)
    const agentOptions = { provider: bot.provider, model: bot.model }
    const setup = (agentCtx: Context): void => {
      agentCtx.systemPrompt.section({
        name: 'chat:persona',
        order: 0,
        text: bot.persona,
      })
      // 工作区围栏：session cwd = bot 工作目录，dsh 内置沙箱（workspace-write
      // 模式）自动把全部写操作限制在该目录内，越界抛 FS_SANDBOX_DENIED。
    }
    // A persisted session (restart) resumes with its durable memory intact;
    // a fresh bot has none yet, so the resume falls back to creation.
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: bot.sessionId, agentOptions, setup })
    } catch {
      handle = await this.ctx.agents.create(bot.workspaceDir === undefined
        ? { sessionId: bot.sessionId, agentOptions, setup }
        : { sessionId: bot.sessionId, meta: { cwd: bot.workspaceDir }, agentOptions, setup })
    }
    this.handles.set(id, handle)
    this.ctx.effect(() => () => {
      // The owner fiber's disposal tears the handle down; only forget it here.
      if (this.handles.get(id) === handle) this.handles.delete(id)
      this.personaDispose.delete(id)
    }, `chat-bots agent ${id}`)
    return handle.agent
  }

  /** Swap the persona section of a live agent in place. */
  private applyPersona(agent: Agent, bot: BotRecord): void {
    this.personaDispose.get(bot.id)?.()
    const dispose = agent.ctx.systemPrompt.section({
      name: 'chat:persona',
      order: 0,
      text: bot.persona,
    })
    this.personaDispose.set(bot.id, dispose)
  }

  /** Rebuild the live agent for a bot on its existing durable session. */
  private async rebuildAgent(id: string): Promise<void> {
    const handle = this.handles.get(id)
    const bot = this.get(id)
    if (bot === undefined) return
    if (handle !== undefined) {
      this.handles.delete(id)
      this.personaDispose.delete(id)
      await handle.dispose()
    }
    // ensureAgent resumes through the registry's persistence-backed factory.
    await this.ensureAgent(id)
  }

  /** The `/chatapi/bots` HTTP surface. */
  private registerHttp(): void {
    this.registerSseEndpoint()

    // ── misc endpoints（工作区目录打开 / 默认工作区根 / 会话预览）──
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/misc',
      handler: async (req, res) => {
        try {
          const json = (status: number, body: unknown): void => {
            res.writeHead(status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          }
          if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
          const body = await readBody(req)
          const action = String(body.action ?? '')

          // 打开本地目录/URL（Finder / 资源管理器 / 浏览器）
          if (action === 'open-dir') {
            const dir = String(body.dir ?? '').trim()
            if (dir === '') return json(400, { error: 'dir 必填' })
            const target = dir.startsWith('~/')
              ? join(process.env.HOME ?? '', dir.slice(2))
              : dir
            const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
            const child = spawn(command, [target], { stdio: 'ignore', detached: false })
            const code = await new Promise<number | null>((resolve) => {
              child.once('exit', code => resolve(code))
              child.once('error', () => resolve(null))
            })
            if (code !== 0 && code !== null) return json(500, { error: `打开目录失败 (exit ${String(code)})` })
            if (code === null) return json(500, { error: '无法启动系统打开命令' })
            return json(200, { ok: true, dir: target })
          }

          // 默认工作区根（旧版约定 ~/chat-agent-workspace）
          if (action === 'default-workspace-dir') {
            const base = join(process.env.HOME ?? '', 'chat-agent-workspace')
            await mkdir(base, { recursive: true })
            return json(200, { dir: base })
          }

          // 会话列表预览：返回 bot 私聊/群聊的最后一行
          if (action === 'conversation-previews') {
            const previews: Record<string, { preview: string; at: number }> = {}
            for (const bot of this.listAll()) {
              try {
                const agent = await this.ensureAgent(bot.id)
                const rows = renderPrivateHistory(agent.session, bot.id, bot.name)
                const last = rows.at(-1)
                if (last !== undefined) previews[`private:${bot.id}`] = { preview: last.text.slice(0, 60), at: last.time }
              } catch {
                // 简历失败的会话跳过预览
              }
            }
            return json(200, { previews })
          }

          return json(404, { error: `unknown action "${action}"` })
        } catch (error: unknown) {
          return json(res, 500, { error: String(error) })
        }
      },
    })

    const json = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    const readBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text === '' ? {} : JSON.parse(text) as Record<string, unknown>
    }

    const parseBotInput = (body: unknown): BotCreateInput => {
      const raw = body as Record<string, unknown>
      if (typeof raw.name !== 'string' || raw.name === '') throw new Error('name is required')
      return {
        name: raw.name,
        avatar: typeof raw.avatar === 'string' ? raw.avatar : undefined,
        persona: typeof raw.persona === 'string' ? raw.persona : '',
        introduction: typeof raw.introduction === 'string' ? raw.introduction : undefined,
        workspaceDir: typeof raw.workspaceDir === 'string' ? raw.workspaceDir : undefined,
        provider: typeof raw.provider === 'string' ? raw.provider : 'deepseek',
        model: typeof raw.model === 'string' ? raw.model : '',
        trigger: raw.trigger === undefined ? undefined : raw.trigger as BotCreateInput['trigger'],
      }
    }

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/models',
      handler: async (req, res) => {
        try {
          const models = this.models
          if (models === undefined) return json(res, 503, { error: 'model store not ready' })
          const match = /^\/chatapi\/models(?:\/([^/]+))?$/.exec(req.url ?? '')
          if (match === null) return json(res, 404, { error: 'not found' })
          const modelId = match[1]

          // GET /chatapi/models — 列表（含 route_id 供 bot 绑定）
          if (modelId === undefined && req.method === 'GET') {
            return json(res, 200, { items: models.list().map(toFrontModel) })
          }

          // POST /chatapi/models — 创建并同步 llm-pi-ai 路由 + 凭据
          if (modelId === undefined && req.method === 'POST') {
            const input = parseModelInput(await readBody(req))
            const now = Date.now()
            const record: ModelRecord = {
              ...input,
              id: `model-${randomUUID()}`,
              createdAt: now,
              updatedAt: now,
            }
            if (record.name === '') return json(res, 400, { error: 'name 不能为空' })
            if (record.modelName === '') return json(res, 400, { error: 'model_name 不能为空' })
            if (record.provider === 'custom' && record.baseUrl === '') {
              return json(res, 400, { error: '自定义供应商必须填写接口地址' })
            }
            await syncRoute(await this.servicesReady, record, record.apiKey)
            await models.put(record)
            return json(res, 200, toFrontModel(record))
          }

          // PUT /chatapi/models/:id — 更新并重同步路由
          if (modelId !== undefined && req.method === 'PUT') {
            const current = models.get(modelId)
            if (current === undefined) return json(res, 404, { error: `model "${modelId}" not found` })
            const input = parseModelInput(await readBody(req), current)
            const record: ModelRecord = { ...current, ...input, updatedAt: Date.now() }
            if (record.name === '') return json(res, 400, { error: 'name 不能为空' })
            if (record.modelName === '') return json(res, 400, { error: 'model_name 不能为空' })
            if (record.provider === 'custom' && record.baseUrl === '') {
              return json(res, 400, { error: '自定义供应商必须填写接口地址' })
            }
            await removeRoute(await this.servicesReady, record.id, record.provider)
            await syncRoute(await this.servicesReady, record, record.apiKey)
            await models.put(record)
            return json(res, 200, toFrontModel(record))
          }

          // DELETE /chatapi/models/:id — 删除记录与路由
          if (modelId !== undefined && req.method === 'DELETE') {
            const current = models.get(modelId)
            if (current === undefined) return json(res, 404, { error: `model "${modelId}" not found` })
            await removeRoute(await this.servicesReady, current.id, current.provider)
            await models.delete(current.id)
            return json(res, 200, { deleted: true })
          }

          return json(res, 405, { error: 'method not allowed' })
        } catch (error: unknown) {
          this.ctx.logger.warn('chat-bots models endpoint failed: %s', (error as Error)?.stack ?? String(error))
          return json(res, 500, { error: (error as Error)?.stack ?? String(error) })
        }
      },
    })

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/skills',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/skills(?:\/([^/]+))?(\/[a-z-]+)?$/.exec(req.url ?? '')
          if (match === null) return json(res, 404, { error: 'not found' })
          const skillName = match[1]
          const action = match[2]
          const userSkillsRoot = join(resolveDshHome(), 'skills')

          // GET /chatapi/skills — dsh skill 注册表投影（含 bundled + user + project）
          if (skillName === undefined && action === undefined && req.method === 'GET') {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
            const snapshot = await this.ctx.skills.snapshot()
            const skills = await Promise.all(snapshot.skills.map(async (summary) => {
              const definition = await this.ctx.skills.get(summary.name).catch(() => undefined)
              const path = definition?.path ?? ''
              return {
                name: summary.name,
                description: summary.description,
                location: path === '' ? '' : path.slice(0, -'/SKILL.md'.length),
                path,
                body: definition?.content ?? '',
                source: summary.source,
                disableModelInvocation: !summary.invocation.modelInvocable,
                internal: false,
                builtin: summary.source === 'bundled',
              }
            }))
            return json(res, 200, { skills, diagnostics: [] })
          }

          // POST /chatapi/skills — 从模板创建（写入 $DSH_HOME/skills/<name>/SKILL.md）
          if (skillName === undefined && action === undefined && req.method === 'POST') {
            const body = await readBody(req)
            const name = typeof body.name === 'string' ? body.name : ''
            const description = typeof body.description === 'string' ? body.description.trim() : ''
            if (!isSkillName(name)) return json(res, 400, { error: 'name 只能包含小写字母、数字和连字符' })
            if (description === '') return json(res, 400, { error: 'description 不能为空' })
            const skillDir = join(userSkillsRoot, name)
            const location = join(skillDir, 'SKILL.md')
            try {
              await access(location)
              return json(res, 400, { error: `SKILL.md 已存在: ${location}` })
            } catch (error: unknown) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            const title = name.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
            const content = [
              '---',
              `name: ${name}`,
              `description: ${description}`,
              '---',
              '',
              `# ${title}`,
              '',
              description,
              '',
              '## When to Use',
              '',
              'Describe the scenarios where this skill should be used.',
              '',
              '## Steps',
              '',
              '1. First, do this',
              '2. Then, do that',
              '',
              '## Examples',
              '',
              '```',
              'Example usage or code snippets',
              '```',
              '',
            ].join('\n')
            await mkdir(skillDir, { recursive: true })
            await writeFile(location, content, 'utf-8')
            return json(res, 200, { skillDir, location, content })
          }

          // DELETE /chatapi/skills/:name — 仅允许删除 user-dsh 根下的技能
          if (skillName !== undefined && action === undefined && req.method === 'DELETE') {
            if (!isSkillName(skillName)) return json(res, 400, { error: 'invalid skill name' })
            const skillDir = join(userSkillsRoot, skillName)
            try {
              await access(join(skillDir, 'SKILL.md'))
            } catch {
              return json(res, 404, { error: `skill "${skillName}" not found under ${userSkillsRoot}` })
            }
            await rm(skillDir, { recursive: true, force: true })
            return json(res, 200, { deleted: true, path: skillDir })
          }

          // POST /chatapi/skills/install-local — 从本地目录批量安装
          if (skillName === undefined && action === '/install-local' && req.method === 'POST') {
            const body = await readBody(req)
            const srcDir = typeof body.srcDir === 'string' ? body.srcDir : ''
            const filter = Array.isArray(body.skillFilter) ? body.skillFilter.filter((item): item is string => typeof item === 'string') : undefined
            if (srcDir === '') return json(res, 400, { error: 'srcDir is required' })
            let entries: string[]
            try {
              entries = await readdir(srcDir)
            } catch {
              return json(res, 400, { error: `无法读取目录: ${srcDir}` })
            }
            const installed: string[] = []
            const skipped: string[] = []
            for (const entry of entries) {
              if (filter !== undefined && !filter.includes(entry)) continue
              const candidate = join(srcDir, entry)
              try {
                await access(join(candidate, 'SKILL.md'))
              } catch {
                skipped.push(entry)
                continue
              }
              await rm(join(userSkillsRoot, entry), { recursive: true, force: true })
              await cp(candidate, join(userSkillsRoot, entry), { recursive: true })
              installed.push(entry)
            }
            return json(res, 200, { installed, skipped })
          }

          return json(res, 405, { error: 'method not allowed' })
        } catch (error: unknown) {
          this.ctx.logger.warn('chat-bots skills endpoint failed: %o', error)
          return json(res, 500, { error: String(error) })
        }
      },
    })

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/tools',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        // 全局注册表投影（对 bot agent 还会叠加 persona/preset 作用域工具）
        const schemas = this.ctx.tools.schemas()
        return json(res, 200, {
          items: schemas.map(schema => ({
            name: schema.name,
            label: schema.name,
            description: schema.description ?? '',
            source: 'builtin',
            available: true,
          })),
        })
      },
    })

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/bots',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/bots(?:\/([^/]+))?(\/[a-z]+)?$/.exec(req.url ?? '')
          if (match === null) return json(res, 404, { error: 'not found' })
          const botId = match[1]
          const action = match[2]

          /** Bot record + the custom-model id bound to its provider route. */
          const enrich = (bot: BotRecord): Record<string, unknown> => ({
            ...bot,
            modelId: this.models?.list().find(model => routeIdFor(model.id) === bot.provider)?.id ?? null,
            agentEnabled: bot.workspaceDir !== undefined ? 1 : 0,
          })

          if (botId === undefined) {
            if (req.method === 'GET') return json(res, 200, { items: this.list().map(enrich) })
            if (req.method === 'POST') {
              const bot = await this.create(parseBotInput(await readBody(req)))
              return json(res, 200, enrich(bot))
            }
            return json(res, 405, { error: 'method not allowed' })
          }

          if (action === '/clear') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            await this.clear(botId)
            // 通知前端清除该会话的全部本地状态（含流式残留）
            this.broadcast('message.cleared', { conversationId: `private:${botId}` })
            return json(res, 200, { cleared: true })
          }

          if (action === '/send') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            const body = await readBody(req)
            if (typeof body.content !== 'string' || body.content === '') {
              return json(res, 400, { error: 'content is required' })
            }
            const agent = await this.ensureAgent(botId)
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: body.content }],
              source: { kind: 'user' },
            }))
            return json(res, 200, { accepted: true })
          }

          if (action === '/history') {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
            const bot = this.get(botId)
            if (bot === undefined) return json(res, 404, { error: 'bot not found' })
            const agent = await this.ensureAgent(botId)
            return json(res, 200, { items: renderPrivateHistory(agent.session, bot.id, bot.name) })
          }

          if (req.method === 'GET') {
            const bot = this.get(botId)
            return bot === undefined ? json(res, 404, { error: 'bot not found' }) : json(res, 200, enrich(bot))
          }
          if (req.method === 'PUT' || req.method === 'PATCH') {
            const bot = await this.update(botId, await readBody(req) as BotUpdatePatch)
            return json(res, 200, enrich(bot))
          }
          if (req.method === 'DELETE') {
            await this.remove(botId)
            return json(res, 200, { ok: true })
          }
          return json(res, 405, { error: 'method not allowed' })
        } catch (error: unknown) {
          return json(res, 400, { error: String(error) })
        }
      },
    })
  }
}

/** Mount the bot registry. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ChatBots, config)
}
