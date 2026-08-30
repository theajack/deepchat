/**
 * The chat-agent bot registry: durable companion records over a storage
 * domain, lazy per-bot agents whose persona rides a scoped prompt section,
 * and the `/chatapi/bots` HTTP surface the desktop UI consumes.
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// `domainTable` validates with zod (same as models.ts / schema.ts); the
// schemastery default import above is the plugin-config dialect.
import { z as zod } from 'zod'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { EncodedImageAttachment } from '@deepseek-ai/dsh-attachment/types'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls in the `webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: pulls in the `tools` Context augmentation.
import type {} from '@deepseek-ai/dsh-tools'
// Side-effect type import: pulls in the `settings`/`credentials` augmentations.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-credentials'
import { ModelPreferenceStore, DEFAULT_MODEL_KEY, GROUP_JUDGE_MODEL_KEY, type ModelRecord, mirrorDeepSeekCredential, modelRecordSchema, ModelStore, removeRoute, routeIdFor, syncRoute } from './models.ts'
import { formatInstalls, installGithubSkill, searchSkillsApi } from './skills-remote.ts'
import { buildBotAgentSetup, resolveEnabledSkills } from './agent-setup.ts'
import { LlmTraceRecorder } from './llm-trace.ts'
import { writeBotAvatar } from './avatar.ts'
import {
  consolidateMemory,
  extractTranscript,
  memoryUpdatedAt,
  readMemory,
  writeMemory,
  type MemorySourceRow,
} from './memory.ts'

export { extractTranscript, memoryUpdatedAt, readMemory, writeMemory } from './memory.ts'
export type { MemorySourceRow } from './memory.ts'
export { generatePersonaText } from './persona.ts'
export type { PersonaGenerateOptions, PersonaKind } from './persona.ts'
export { routeIdFor, ModelPreferenceStore, DEFAULT_MODEL_KEY, GROUP_JUDGE_MODEL_KEY } from './models.ts'
import { configureDebugLog, debugLog, isDebugLogEnabled, tailDebugLog, DEBUG_LOG_PATH } from './debug-log.ts'
import { generatePersonaText, type PersonaKind } from './persona.ts'
import { pageRows, renderPrivateHistory, translateSessionEvent } from './bridge.ts'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { BotCreateInput, BotRecord, BotUpdatePatch } from './types.ts'
import { botRecordSchema } from './schema.ts'

export type { BotCreateInput, BotRecord, BotUpdatePatch, TriggerConfig } from './types.ts'
export { buildBotAgentSetup, resolveEnabledSkills } from './agent-setup.ts'
export type { EnabledSkillSummary } from './agent-setup.ts'

/** Cordis plugin name. */
export const name = 'chat-bots'

/**
 * Agent/skill/tool registries, the LLM seam (memory consolidation calls it
 * directly), the settings/credentials resolvers, storage domain, attachments,
 * and HTTP are required.
 *
 * `settings`/`credentials` are intentionally absent: declaring them deadlocks
 * the boot order (they activate after the chat plugins), so they are requested
 * dynamically via `ctx.inject` in the constructor instead.
 *
 * `fs` backs the scoped `read_document` tool, which resolves and reads
 * attachments through the filesystem service rather than `node:fs` so the
 * sandbox and observation policy apply. It must be declared here (and in
 * chat-group, which reuses `buildBotAgentSetup`) or the tool throws
 * "cannot get property \"fs\" without inject" the first time it is called.
 */
export const inject = ['agents', 'llm', 'tools', 'skills', 'storageDomain', 'webServer', 'attachments', 'fs']

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
    // Free-form key/value settings (e.g. the user's default model choice).
    meta: domainTable<string, string>(zod.string()),
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

  /** The user's default-model choice, backing background work (memory). */
  private defaultModel: ModelPreferenceStore | undefined

  /** The model arbitrating who speaks next in group chats. */
  private groupJudge: ModelPreferenceStore | undefined

  /** Live agent handles by bot id; disposal removes the entry. */
  private readonly handles = new Map<string, AgentHandle>()
  /** 本地图片头像目录（与 workspace/agents 同级，按 id 命名） */
  private readonly avatarDir = join(resolveDshHome(), 'workspace', 'agents')

  /** Persona-section disposers by bot id, for live persona edits. */
  private readonly personaDispose = new Map<string, () => void>()

  /** Memory-section disposers by bot id, for live memory refreshes. */
  private readonly memoryDispose = new Map<string, () => void>()

  /**
   * In-flight memory consolidation per bot. Chains new work onto the previous
   * promise so two clears of the same bot never write the file concurrently
   * (different bots still run in parallel).
   */
  private readonly pendingMemory = new Map<string, Promise<void>>()

  /** LLM call trace recorder backing the debug「对话信息」window. */
  private trace: LlmTraceRecorder | undefined

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
    this.defaultModel = new ModelPreferenceStore(this.domain, this.models, DEFAULT_MODEL_KEY)
    this.groupJudge = new ModelPreferenceStore(this.domain, this.models, GROUP_JUDGE_MODEL_KEY)
    // 一次性回填：为缺少工作目录的旧好友记录补建 workspace/agents/{id}
    const bots = this.domain.table('bots')
    for (const [id, bot] of bots.entries()) {
      if (bot.workspaceDir !== undefined) continue
      const workspaceDir = join(resolveDshHome(), 'workspace', 'agents', id)
      await mkdir(workspaceDir, { recursive: true })
      await bots.put(id, { ...bot, workspaceDir, updatedAt: Date.now() })
    }
    this.registerHttp()
    // 一次性凭证镜像：把官方 DeepSeek 模型记录的 key 同步到共享
    // DEEPSEEK_API_KEY（web_search 等 dsh 内置功能读这个引用），存量记录
    // 无需重新保存即生效。注意：不能在 init 里 await servicesReady ——
    // settings/credentials 激活晚于 chat 插件，await 会让 chatBots 服务
    // 永远无法激活，进而 chat-group 一直 pending 导致 boot 失败。
    void this.servicesReady.then((servicesCtx) => {
      const models = this.models
      if (models !== undefined) mirrorDeepSeekCredential(servicesCtx, models.list())
    }).catch(() => {})
    // LLM 调用追踪：拦截全部 llm/stream waterfall，供调试面板「对话信息」查看
    this.trace = new LlmTraceRecorder(this.ctx, (sessionId) => {
      const bot = sessionId === undefined ? undefined : this.botBySessionId(sessionId)
      return bot === undefined ? undefined : { botId: bot.id, botName: bot.name }
    })
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
    // 本地调试日志：开关开启时每个广播事件落盘（老方案 cli.log 语义迁移）
    debugLog(event, data)
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

  /**
   * `POST /chatapi/persona/generate` — stream one auxiliary text
   * (bot persona / self intro / group intro) back as SSE deltas.
   *
   * Streaming (rather than a single JSON response) keeps the editor field
   * filling in live, exactly like the old CLI's `persona.stream` events did.
   * The model is the **general-purpose model** unless the caller pins one:
   * these are editor-assistant calls, unrelated to whichever model the bot
   * itself chats with.
   */
  private registerPersonaEndpoint(): void {
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/persona',
      handler: async (req, res) => {
        const fail = (status: number, error: string): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error }))
        }
        if (req.method !== 'POST') return fail(405, 'method not allowed')

        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        let body: Record<string, unknown> = {}
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          if (text !== '') body = JSON.parse(text) as Record<string, unknown>
        } catch {
          return fail(400, 'invalid JSON body')
        }

        const kind = body.kind
        if (kind !== 'botPersona' && kind !== 'selfIntro' && kind !== 'groupIntro') {
          return fail(400, 'kind must be botPersona | selfIntro | groupIntro')
        }
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (name === '') return fail(400, 'name 不能为空')

        // 模型：调用方指定优先，否则用设置里的通用处理模型（群聊调度偏好）
        const models = this.models
        const requestedId = typeof body.modelId === 'string' && body.modelId !== '' ? body.modelId : undefined
        const record = (requestedId === undefined ? undefined : models?.get(requestedId)) ?? this.groupJudgeModel()
        if (record === undefined) return fail(400, '还没有可用模型，请先在设置里添加模型')

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        const send = (payload: unknown): void => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }

        const memberNames = Array.isArray(body.memberNames)
          ? body.memberNames.filter((item): item is string => typeof item === 'string')
          : []

        try {
          const content = await generatePersonaText({
            ctx: this.ctx,
            kind: kind as PersonaKind,
            provider: routeIdFor(record.id),
            model: record.modelName,
            name,
            partial: typeof body.partial === 'string' ? body.partial : '',
            memberNames,
            onDelta: (delta) => { send({ delta }) },
          })
          send({ done: true, content })
        } catch (error: unknown) {
          this.ctx.logger.warn('chat-bots: persona generation failed: %o', error)
          send({ error: error instanceof Error ? error.message : String(error) })
        }
        res.end()
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
    // 本地图片头像：dataURL 写入 botDir/avatar.<ext>，avatar 字段替换为 /chatapi/avatars/:id.<ext>
    let avatar: string | undefined = input.avatar
    if (typeof input.avatarData === 'string' && input.avatarData !== '') {
      const { avatar: written } = await writeBotAvatar(workspaceDir, input.avatarData)
      avatar = written
    }
    const record: BotRecord = {
      ...input,
      ...(avatar !== undefined ? { avatar } : {}),
      workspaceDir,
      trigger,
      id,
      sessionId: `session-${randomUUID()}` as SessionId,
      createdAt: now,
      updatedAt: now,
    }
    delete (record as unknown as { avatarData?: unknown }).avatarData
    await mkdir(workspaceDir, { recursive: true })
    await this.store.table('bots').put(record.id, record)
    return record
  }

  /** Patch a bot; persona edits apply live, model/capability edits rebuild the agent. */
  async update(id: string, patch: BotUpdatePatch & { avatarData?: string }): Promise<BotRecord> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`chat-bots: bot "${id}" not found`)
    // Capability lists arriving as explicit `undefined` (a partial patch) must
    // not erase the stored values through the record spread below.
    const sanitized: BotUpdatePatch & { avatarData?: string } = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined)) as BotUpdatePatch & { avatarData?: string }
    // 本地图片头像：dataURL 写入 botDir/avatar.<ext>，avatar 字段替换为 /chatapi/avatars/:id.<ext>
    let avatarPatch: { avatar: string } | undefined
    if (typeof sanitized.avatarData === 'string' && sanitized.avatarData !== '' && current.workspaceDir !== undefined) {
      const { avatar } = await writeBotAvatar(current.workspaceDir, sanitized.avatarData)
      avatarPatch = { avatar }
    }
    delete sanitized.avatarData
    const next: BotRecord = {
      ...current,
      ...sanitized,
      ...(avatarPatch !== undefined ? avatarPatch : {}),
      trigger: sanitized.trigger ?? current.trigger,
      updatedAt: Date.now(),
    }
    // 用户自定义工作目录必须真实存在：agent 的沙箱 cwd、文件工具与长期记忆
    // 都以它为根，指向不存在的路径会让好友一开口就报错。
    if (next.workspaceDir !== undefined && next.workspaceDir !== current.workspaceDir) {
      await mkdir(next.workspaceDir, { recursive: true })
    }
    await this.store.table('bots').put(id, next)

    const modelChanged = sanitized.provider !== undefined || sanitized.model !== undefined
    const personaChanged = sanitized.persona !== undefined && sanitized.persona !== current.persona
    // Agent 开关在 setup（agent 级 tools.guard）中生效，切换必须重建 agent
    const effectiveAgentEnabled = current.agentEnabled ?? current.workspaceDir !== undefined
    const agentToggleChanged = sanitized.agentEnabled !== undefined && Boolean(sanitized.agentEnabled) !== effectiveAgentEnabled
    // 工具/技能/MCP 白名单全部在 agent setup 中生效，变化必须重建 agent
    const capabilitiesChanged = (['enabledTools', 'enabledSkills', 'enabledMcpServers'] as const)
      .some(key => sanitized[key] !== undefined && JSON.stringify(sanitized[key]) !== JSON.stringify(current[key]))
    // 工作目录是 agent 的 cwd，写死在会话 meta 里，改了必须重建才生效
    const workspaceChanged = sanitized.workspaceDir !== undefined && sanitized.workspaceDir !== current.workspaceDir

    if (this.handles.has(id)) {
      if (modelChanged || agentToggleChanged || capabilitiesChanged || workspaceChanged) {
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
    // 先快照对话原料：session 日志马上要删除，而快照出来的 rows 只是普通数组，
    // 后续沉淀完全脱离清理链路（不 await，不阻塞清空）。
    const rows = await this.snapshotBotMemory(bot)
    if (rows !== undefined) this.consolidateBotMemory(bot, rows)
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
    // Enabled-skill summaries are resolved up front: the setup callback must
    // stay synchronous, so the async registry lookup happens before creation.
    const skillSummaries = await resolveEnabledSkills(this.ctx, bot)
    // 长期记忆：存在 workspace 下，清空对话不会丢失
    const memory = await readMemory(bot.workspaceDir)
    // Shared capability wiring: persona section, agent-disable triple guard,
    // tool whitelist, and the enabled-skill catalog + `skill` loader tool.
    const setup = buildBotAgentSetup(this.ctx, bot, skillSummaries, memory)
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
      this.memoryDispose.delete(id)
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

  /** Swap the memory section of a live agent in place (after consolidation). */
  private async applyMemory(agent: Agent, bot: BotRecord): Promise<void> {
    this.memoryDispose.get(bot.id)?.()
    const memory = (await readMemory(bot.workspaceDir)).trim()
    if (memory === '') {
      this.memoryDispose.delete(bot.id)
      return
    }
    this.memoryDispose.set(bot.id, agent.ctx.systemPrompt.section({
      name: 'chat:memory',
      order: 1,
      text: `【长期记忆】以下是你与这位用户长期相处沉淀下来的记忆，跨会话持续有效（清空对话不会丢失）。请自然地运用它，但不要生硬地复述或主动提及"我的记忆里写着"。\n\n${memory}`,
    }))
  }

  /**
   * Refresh the live agent's memory section once a consolidation lands, so the
   * next reply already reflects the new document. No live agent (the common
   * case right after `clear()`) is fine: `ensureAgent` reads the file later.
   */
  private async refreshMemorySection(id: string): Promise<void> {
    const handle = this.handles.get(id)
    const bot = this.get(id)
    if (handle === undefined || bot === undefined) return
    await this.applyMemory(handle.agent, bot)
  }

  /**
   * Distill a conversation into the bot's long-term memory, fire-and-forget.
   *
   * Never awaited by the caller: the rows are already an in-memory snapshot, so
   * clearing the session right after enqueuing loses nothing.
   */
  consolidateBotMemory(bot: BotRecord, rows: readonly MemorySourceRow[]): void {
    if (rows.length === 0) return
    const previous = this.pendingMemory.get(bot.id) ?? Promise.resolve()
    const next = previous.then(async () => {
      const model = this.defaultModel?.resolve()
      if (model === undefined) return
      try {
        const written = await consolidateMemory({
          ctx: this.ctx,
          botName: bot.name,
          workspaceDir: bot.workspaceDir,
          rows,
          provider: routeIdFor(model.id),
          model: model.modelName,
        })
        if (written) await this.refreshMemorySection(bot.id)
      } catch (error: unknown) {
        // Failures never surface to the UI: clearing a chat must always succeed.
        this.ctx.logger.warn('chat-bots: memory consolidation failed for "%s": %o', bot.id, error)
      }
    })
    this.pendingMemory.set(bot.id, next)
    void next.finally(() => {
      if (this.pendingMemory.get(bot.id) === next) this.pendingMemory.delete(bot.id)
    })
  }

  /**
   * Snapshot one bot's conversation so it can outlive its session.
   * Returns undefined when there is nothing worth distilling.
   */
  async snapshotBotMemory(bot: BotRecord): Promise<readonly MemorySourceRow[] | undefined> {
    // 无可用模型时不必付出 ensureAgent 的成本
    if (this.defaultModel?.resolve() === undefined) return undefined
    try {
      const agent = await this.ensureAgent(bot.id)
      const rows = extractTranscript(agent.session)
      return rows.length === 0 ? undefined : rows
    } catch (error: unknown) {
      this.ctx.logger.warn('chat-bots: memory snapshot failed for "%s": %o', bot.id, error)
      return undefined
    }
  }

  /**
   * The model arbitrating who speaks next in a group chat.
   *
   * Three-step fallback: an explicit scheduling model → the default model →
   * the newest record. So scheduling works out of the box; the dedicated
   * setting only exists to override it with something cheaper or smarter.
   *
   * Undefined only when no model is configured at all, in which case the group
   * plugin falls back to its rule engine.
   */
  groupJudgeModel(): ModelRecord | undefined {
    return this.groupJudge?.resolveExplicit() ?? this.defaultModel?.resolve()
  }

  /**
   * What the UI needs to render the scheduling marker: which model is
   * explicitly set, and which one actually takes effect (they differ whenever
   * the fallback is in play).
   */
  groupJudgeModelIds(): { id: string | null; effectiveId: string | null } {
    return {
      id: this.groupJudge?.id() ?? null,
      effectiveId: this.groupJudgeModel()?.id ?? null,
    }
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
    this.registerPersonaEndpoint()

    // ── 本地头像文件读取（settings editor 上传后的展示）──
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/avatars',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/avatars\/([^/]+)\/(.+)$/.exec(req.url ?? '')
          if (match === null || match[1] === undefined || match[2] === undefined) { res.writeHead(404); res.end(); return }
          const botId = decodeURIComponent(match[1])
          const fileName = decodeURIComponent(match[2])
          if (!/^bot-[a-zA-Z0-9_-]+$/.test(botId)) {
            res.writeHead(400); res.end('bad bot id'); return
          }
          if (!/^avatar\.[a-z]{2,5}$/.test(fileName)) {
            res.writeHead(400); res.end('bad file name'); return
          }
          const filePath = join(this.avatarDir, botId, fileName)
          const info = await stat(filePath).catch(() => null)
          if (info === null || !info.isFile()) {
            res.writeHead(404); res.end('not found'); return
          }
          const bytes = await readFile(filePath)
          const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
          const mime = ext === 'jpg' ? 'image/jpeg'
            : ext === 'svg' ? 'image/svg+xml'
              : ext === 'webp' ? 'image/webp'
                : `image/${ext}`
          res.writeHead(200, {
            'content-type': mime,
            'content-length': String(bytes.byteLength),
            'cache-control': 'private, max-age=86400',
          })
          res.end(bytes)
        } catch (error: unknown) {
          this.ctx.logger.warn('chat-bots avatar fetch failed: %o', error)
          res.writeHead(500); res.end(String(error))
        }
      },
    })

    // ── llm-trace endpoints（调试面板「对话信息」窗口）──
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/llm-trace',
      handler: async (req, res) => {
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method === 'GET') return json(200, this.trace?.list() ?? [])
          if (req.method === 'DELETE') {
            this.trace?.clear()
            return json(200, { ok: true })
          }
          return json(405, { error: 'method not allowed' })
        } catch (error: unknown) {
          this.ctx.logger.warn('chat-bots llm-trace endpoint failed: %o', error)
          return json(500, { error: String(error) })
        }
      },
    })

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

          // 本地调试日志：开关实时生效（老方案 configureDebugLog 迁移）
          if (action === 'debug-log') {
            if (typeof body.enabled === 'boolean') configureDebugLog(body.enabled)
            return json(200, { enabled: isDebugLogEnabled(), path: DEBUG_LOG_PATH })
          }

          // 本地调试日志：读取最近 n 行（面板预览）
          if (action === 'debug-log-tail') {
            const n = typeof body.lines === 'number' && body.lines > 0 ? Math.min(body.lines, 1000) : 200
            return json(200, { tail: tailDebugLog(n), path: DEBUG_LOG_PATH })
          }

          // 数据目录清单：dsh home 下真实存在的存储位置（设置页「数据目录」）
          if (action === 'data-dirs') {
            const root = resolveDshHome()
            const entries = [
              { name: 'storages/', rel: 'storages' },
              { name: 'workspace/agents/', rel: 'workspace/agents' },
              { name: 'workspace/groups/', rel: 'workspace/groups' },
              { name: 'sessions/', rel: 'sessions' },
              { name: 'skills/', rel: 'skills' },
              { name: 'logs/', rel: 'logs' },
            ]
            await Promise.all(entries.map(entry => mkdir(join(root, entry.rel), { recursive: true })))
            return json(200, {
              root,
              dirs: entries.map(entry => ({ name: entry.name, path: join(root, entry.rel) })),
            })
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
      const strArray = (key: string): string[] | undefined => {
        const value = raw[key]
        if (!Array.isArray(value)) return undefined
        return value.filter((item): item is string => typeof item === 'string')
      }
      return {
        name: raw.name,
        avatar: typeof raw.avatar === 'string' ? raw.avatar : undefined,
        persona: typeof raw.persona === 'string' ? raw.persona : '',
        introduction: typeof raw.introduction === 'string' ? raw.introduction : undefined,
        agentEnabled: typeof raw.agentEnabled === 'boolean' ? raw.agentEnabled : undefined,
        workspaceDir: typeof raw.workspaceDir === 'string' ? raw.workspaceDir : undefined,
        provider: typeof raw.provider === 'string' ? raw.provider : 'deepseek',
        model: typeof raw.model === 'string' ? raw.model : '',
        trigger: raw.trigger === undefined ? undefined : raw.trigger as BotCreateInput['trigger'],
        enabledTools: strArray('enabledTools'),
        enabledSkills: strArray('enabledSkills'),
        enabledMcpServers: strArray('enabledMcpServers'),
        ...(typeof raw.avatarData === 'string' ? { avatarData: raw.avatarData } : {}),
      }
    }

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/models',
      handler: async (req, res) => {
        try {
          const models = this.models
          if (models === undefined) return json(res, 503, { error: 'model store not ready' })
          const match = /^\/chatapi\/models(?:\/([^/]+))?(?=\?|$)/.exec((req.url ?? '').split('?')[0] ?? '')
          if (match === null) return json(res, 404, { error: 'not found' })
          const modelId = match[1]

          // 模型偏好（默认模型 / 群聊调度模型）。model id 恒为 `model-<uuid>`，
          // 永不等于这两个保留字，故与 /:id 路由无冲突。
          const preference = modelId === 'group-judge'
            ? this.groupJudge
            : modelId === 'default'
              ? this.defaultModel
              : undefined
          if (preference !== undefined) {
            if (req.method === 'GET') {
              // 群聊调度会回落到默认模型再回落到首个模型，UI 需要看到真正生效的那个
              return modelId === 'group-judge'
                ? json(res, 200, this.groupJudgeModelIds())
                : json(res, 200, { id: preference.id() ?? null, effectiveId: preference.id() ?? null })
            }
            if (req.method === 'POST') {
              const body = await readBody(req)
              const id = typeof body.id === 'string' ? body.id.trim() : ''
              if (id !== '' && models.get(id) === undefined) {
                return json(res, 404, { error: `model "${id}" not found` })
              }
              if (id === '') await preference.clear()
              else await preference.set(id)
              return modelId === 'group-judge'
                ? json(res, 200, this.groupJudgeModelIds())
                : json(res, 200, { id: preference.id() ?? null, effectiveId: preference.id() ?? null })
            }
            return json(res, 405, { error: 'method not allowed' })
          }

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
            await mirrorDeepSeekCredential(await this.servicesReady, [record])
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
            await mirrorDeepSeekCredential(await this.servicesReady, [...models.list(), record])
            await models.put(record)
            return json(res, 200, toFrontModel(record))
          }

          // DELETE /chatapi/models/:id — 删除记录与路由
          if (modelId !== undefined && req.method === 'DELETE') {
            const current = models.get(modelId)
            if (current === undefined) return json(res, 404, { error: `model "${modelId}" not found` })
            await removeRoute(await this.servicesReady, current.id, current.provider)
            await mirrorDeepSeekCredential(
              await this.servicesReady,
              models.list().filter(m => m.id !== current.id),
            )
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
          const url = req.url ?? ''
          // Action URLs carry a single segment; they must be matched first,
          // otherwise the greedy `([^/]+)` would capture e.g. "install-local"
          // as a skill name and the action branches below would never fire.
          const actionMatch = /^\/chatapi\/skills(\/find|\/install-local|\/install-github)$/.exec(url)
          const match = actionMatch ?? /^\/chatapi\/skills(?:\/([^/]+))?$/.exec(url)
          if (match === null) return json(res, 404, { error: 'not found' })
          const skillName = actionMatch === null ? match[1] : undefined
          const action = actionMatch?.[1]
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

          // POST /chatapi/skills/find — 搜索 skills.sh 远程注册表
          if (skillName === undefined && action === '/find' && req.method === 'POST') {
            const body = await readBody(req)
            const query = typeof body.query === 'string' ? body.query.trim() : ''
            const owner = typeof body.owner === 'string' && body.owner.trim() !== '' ? body.owner.trim() : undefined
            if (query === '') return json(res, 400, { error: 'query 必填' })
            const hits = await searchSkillsApi(query, owner)
            return json(res, 200, {
              skills: hits.map(hit => ({
                name: hit.name,
                slug: hit.slug,
                source: hit.source,
                installs: hit.installs,
                installsLabel: formatInstalls(hit.installs),
                installCommand: `npx skills add ${hit.source || hit.slug}@${hit.name}`,
                url: `https://skills.sh/${hit.slug}`,
              })),
            })
          }

          // POST /chatapi/skills/install-github — 从 GitHub 仓库导入技能
          if (skillName === undefined && action === '/install-github' && req.method === 'POST') {
            const body = await readBody(req)
            const source = typeof body.source === 'string' ? body.source.trim() : ''
            if (source === '') return json(res, 400, { error: 'source 必填' })
            const result = await installGithubSkill(source, userSkillsRoot)
            return json(res, 200, result)
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
        // 作用域工具（注册在每个 agent 的 setup 里，不在全局注册表中）：
        // 手动补充到列表，否则工具页与白名单选择器看不到它们
        const scoped = [
          {
            name: 'openUrl',
            label: 'openUrl',
            description: '打开指定的 URL 或本地 HTML 文件（内置浏览器或系统浏览器）',
            source: 'builtin',
            available: true,
          },
          {
            name: 'fetch',
            label: 'fetch',
            description: '请求指定的 HTTP(S) URL 并返回响应内容（状态码 + 响应体）',
            source: 'builtin',
            available: true,
          },
          {
            name: 'skill',
            label: 'skill',
            description: '加载好友已启用技能的完整说明',
            source: 'builtin',
            available: true,
          },
        ]
        return json(res, 200, {
          items: [
            ...schemas.map(schema => ({
              name: schema.name,
              label: schema.name,
              description: schema.description ?? '',
              source: 'builtin',
              available: true,
            })),
            ...scoped.filter(entry => !schemas.some(schema => schema.name === entry.name)),
          ],
        })
      },
    })

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/bots',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/bots(?:\/([^/]+))?(\/[a-z]+)?(?=\?|$)/.exec((req.url ?? '').split('?')[0] ?? '')
          if (match === null) return json(res, 404, { error: 'not found' })
          const botId = match[1]
          const action = match[2]

          /** Bot record + the custom-model id bound to its provider route. */
          const enrich = (bot: BotRecord): Record<string, unknown> => ({
            ...bot,
            modelId: this.models?.list().find(model => routeIdFor(model.id) === bot.provider)?.id ?? null,
            // 显式开关优先；旧记录（无该字段）回退为按 workspaceDir 推导
            agentEnabled: bot.agentEnabled === undefined
              ? (bot.workspaceDir !== undefined ? 1 : 0)
              : bot.agentEnabled ? 1 : 0,
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

          // 长期记忆：跨会话持久，清空对话不会丢失
          if (action === '/memory') {
            const bot = this.get(botId)
            if (bot === undefined) return json(res, 404, { error: 'bot not found' })
            if (req.method === 'GET') {
              return json(res, 200, {
                text: await readMemory(bot.workspaceDir),
                updatedAt: await memoryUpdatedAt(bot.workspaceDir) ?? null,
              })
            }
            if (req.method === 'PUT') {
              const body = await readBody(req)
              const text = typeof body.text === 'string' ? body.text : ''
              await writeMemory(bot.workspaceDir, text)
              const handle = this.handles.get(botId)
              if (handle !== undefined) await this.applyMemory(handle.agent, bot)
              return json(res, 200, { updatedAt: await memoryUpdatedAt(bot.workspaceDir) ?? null })
            }
            return json(res, 405, { error: 'method not allowed' })
          }

          if (action === '/send') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            const body = await readBody(req)
            const text = typeof body.content === 'string' ? body.content : ''
            const images = Array.isArray(body.images)
              ? body.images.filter((img): img is EncodedImageAttachment =>
                img !== null && typeof img === 'object'
                && typeof (img as { data?: unknown }).data === 'string'
                && typeof (img as { mediaType?: unknown }).mediaType === 'string')
              : []
            if (text === '' && images.length === 0) {
              return json(res, 400, { error: 'content is required' })
            }
            const content: ContentBlock[] = []
            if (text !== '') content.push({ type: 'text', text })
            if (images.length > 0) {
              const refs = await admitEncodedImages(this.ctx.attachments, images)
              content.push(...refs.map((ref): ContentBlock => ({ type: 'image', attachment: ref })))
            }
            const agent = await this.ensureAgent(botId)
            agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
            return json(res, 200, { accepted: true })
          }

          // POST /chatapi/bots/:id/stop — 终止正在生成的回复（取消当前
          // turn：中止模型请求与工具循环；保留会话与历史）
          if (action === '/stop') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            const handle = this.handles.get(botId)
            const agent = handle?.agent
            if (agent === undefined) return json(res, 200, { ok: true, stopped: false })
            const stopped = agent.status === 'running'
            if (stopped) agent.cancel({ kind: 'user' })
            return json(res, 200, { ok: true, stopped })
          }

          if (action === '/history') {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
            const bot = this.get(botId)
            if (bot === undefined) return json(res, 404, { error: 'bot not found' })
            const agent = await this.ensureAgent(botId)
            // 游标分页：?before=<seq> 取更早的一页，?limit=N 页大小（默认 50）
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams
            const raw = query.get('before')
            const before = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined
            const rawLimit = query.get('limit')
            const limit = rawLimit !== null && /^\d+$/.test(rawLimit)
              ? Math.min(Math.max(Number(rawLimit), 1), 200)
              : 50
            const page = pageRows(renderPrivateHistory(agent.session, bot.id, bot.name), before, limit)
            return json(res, 200, { items: page.items, hasMore: page.hasMore })
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
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Await the nested service's activation so the entry only settles once
  // `chatBots` is injectable. Without this, `chat-group` (which injects
  // `chatBots`) can be observed as pending by the boot audit while this
  // service's async init is still in flight, failing the whole boot.
  await ctx.plugin(ChatBots, config).await()
}
