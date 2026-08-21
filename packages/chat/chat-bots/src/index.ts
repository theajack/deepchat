/**
 * The chat-agent bot registry: durable companion records over a storage
 * domain, lazy per-bot agents whose persona rides a scoped prompt section,
 * and the `/chatapi/bots` HTTP surface the desktop UI consumes.
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import { randomUUID } from 'node:crypto'
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
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls in the `webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: pulls in the `tools` Context augmentation.
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { BotCreateInput, BotRecord, BotUpdatePatch } from './types.ts'
import { botRecordSchema } from './schema.ts'

export type { BotCreateInput, BotRecord, BotUpdatePatch, TriggerConfig } from './types.ts'

/** Cordis plugin name. */
export const name = 'chat-bots'

/** Agent registry, tool registry, skill registry, storage domain facility, and the HTTP carrier are required. */
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
  tables: { bots: domainTable<string, BotRecord>(botRecordSchema) },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatBots: ChatBots
  }
}

/** The bot registry service. */
export class ChatBots extends Service {
  private domain: Domain<typeof botsDomainSpec> | undefined

  /** Live agent handles by bot id; disposal removes the entry. */
  private readonly handles = new Map<string, AgentHandle>()

  /** Persona-section disposers by bot id, for live persona edits. */
  private readonly personaDispose = new Map<string, () => void>()

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
    this.registerHttp()
  }

  /** Every bot record, newest first. */
  list(): BotRecord[] {
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
    const record: BotRecord = {
      ...input,
      trigger,
      id: `bot-${randomUUID()}`,
      sessionId: `session-${randomUUID()}` as SessionId,
      createdAt: now,
      updatedAt: now,
    }
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

  /** Delete a bot and tear down its live agent. */
  async remove(id: string): Promise<void> {
    const handle = this.handles.get(id)
    if (handle !== undefined) {
      this.handles.delete(id)
      this.personaDispose.delete(id)
      await handle.dispose()
    }
    await this.store.table('bots').delete(id)
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
    }
    // A persisted session (restart) resumes with its durable memory intact;
    // a fresh bot has none yet, so the resume falls back to creation.
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: bot.sessionId, agentOptions, setup })
    } catch {
      handle = await this.ctx.agents.create({ sessionId: bot.sessionId, agentOptions, setup })
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
        provider: typeof raw.provider === 'string' ? raw.provider : 'deepseek',
        model: typeof raw.model === 'string' ? raw.model : '',
        trigger: raw.trigger === undefined ? undefined : raw.trigger as BotCreateInput['trigger'],
      }
    }

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

          if (botId === undefined) {
            if (req.method === 'GET') return json(res, 200, { items: this.list() })
            if (req.method === 'POST') {
              const bot = await this.create(parseBotInput(await readBody(req)))
              return json(res, 200, bot)
            }
            return json(res, 405, { error: 'method not allowed' })
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
            const agent = await this.ensureAgent(botId)
            return json(res, 200, { items: privateHistory(agent) })
          }

          if (req.method === 'GET') {
            const bot = this.get(botId)
            return bot === undefined ? json(res, 404, { error: 'bot not found' }) : json(res, 200, bot)
          }
          if (req.method === 'PUT' || req.method === 'PATCH') {
            const bot = await this.update(botId, await readBody(req) as BotUpdatePatch)
            return json(res, 200, bot)
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

/** Project a private-chat agent session into simple chat rows. */
function privateHistory(agent: Agent): Array<{ seq: number; time: number; kind: 'user' | 'assistant'; text: string }> {
  const items: Array<{ seq: number; time: number; kind: 'user' | 'assistant'; text: string }> = []
  for (const event of agent.session.events) {
    const row = toRow(event)
    if (row !== undefined) items.push(row)
  }
  return items
}

function toRow(event: SessionEvent): { seq: number; time: number; kind: 'user' | 'assistant'; text: string } | undefined {
  if (event.type === 'user/message') {
    const text = event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return { seq: event.seq, time: event.time, kind: 'user', text }
  }
  if (event.type === 'assistant/message') {
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return { seq: event.seq, time: event.time, kind: 'assistant', text }
  }
  return undefined
}

/** Mount the bot registry. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ChatBots, config)
}
