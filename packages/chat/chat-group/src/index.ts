/**
 * The chat-agent group orchestration: durable groups over a storage domain,
 * a per-group container agent whose session log IS the shared chat record,
 * and the serial multi-bot cascade driven by the trigger rule engine.
 *
 * Flow per human message:
 *   append `group/user-message` → evaluate members (@必回/关键词/概率/冷却)
 *   → for each selected bot (serial): inject rendered group context
 *     (`form: 'relay'`), `followup` a wake notice, await `whenIdle()`, then
 *     append the bot's last assistant text back as `group/bot-message`.
 *   AI messages re-enter evaluation until nobody responds or the round cap
 *   is hit (the anti-infinite-loop bound ported from chat-agent).
 *
 * @module @deepseek-ai/dsh-chat-group
 */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { BotRecord } from '@deepseek-ai/dsh-chat-bots'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls in the `webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { groupRecordSchema } from './schema.ts'
import { shouldRespond } from './trigger.ts'
import type { TriggerMessage } from './trigger.ts'
import type { GroupCreateInput, GroupMessageView, GroupRecord, GroupUpdatePatch } from './types.ts'

export type {
  GroupCreateInput,
  GroupMessageView,
  GroupRecord,
  GroupUpdatePatch,
} from './types.ts'
export { shouldRespond } from './trigger.ts'
export type { TriggerContext, TriggerMessage } from './trigger.ts'

/** Cordis plugin name. */
export const name = 'chat-group'

/** Bot registry, agent registry, storage domain, and the HTTP carrier are required. */
export const inject = ['chatBots', 'agents', 'storageDomain', 'webServer']

/** Plugin config. */
export interface Config {
  /** Round cap for one human message's AI→AI cascade (anti-infinite-loop). */
  readonly maxGroupRounds?: number
  /** Recent group messages rendered into each bot's relay context. */
  readonly contextWindow?: number
}

const DEFAULT_MAX_GROUP_ROUNDS = 3
const DEFAULT_CONTEXT_WINDOW = 20

export const Config: z<Config> = z.object({
  maxGroupRounds: z.natural().default(DEFAULT_MAX_GROUP_ROUNDS),
  contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW),
})

/** The durable group-record storage domain. */
const groupsDomainSpec = defineDomain({
  name: 'chat_groups',
  version: 1,
  tables: { groups: domainTable<string, GroupRecord>(groupRecordSchema) },
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatGroup: ChatGroup
  }
}

/** The group orchestration service. */
export class ChatGroup extends Service {
  private domain: Domain<typeof groupsDomainSpec> | undefined

  /** Live container-agent handles by group id. */
  private readonly containers = new Map<string, AgentHandle>()

  /** Last group-reply time per bot id (epoch ms); in-memory cooldown state. */
  private readonly lastSpoke = new Map<string, number>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'chatGroup')
  }

  private get store(): Domain<typeof groupsDomainSpec> {
    if (this.domain === undefined) throw new Error('chat-group: domain not open')
    return this.domain
  }

  async [Service.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(groupsDomainSpec)
    this.ctx.effect(() => () => {
      void this.domain?.close()
      this.domain = undefined
    }, 'chat-group domain')
    this.registerHttp()
  }

  // ── group CRUD ────────────────────────────────────────────────────────────

  /** Every group record, newest first. */
  list(): GroupRecord[] {
    return [...this.store.table('groups').entries()]
      .map(([, record]) => record)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** One group record, or undefined. */
  get(id: string): GroupRecord | undefined {
    return this.store.table('groups').get(id)
  }

  /** Create a group with its container session identity. */
  async create(input: GroupCreateInput): Promise<GroupRecord> {
    const now = Date.now()
    const record: GroupRecord = {
      name: input.name,
      avatar: input.avatar,
      memberBotIds: input.memberBotIds ?? [],
      id: `group-${randomUUID()}`,
      sessionId: `session-${randomUUID()}` as SessionId,
      createdAt: now,
      updatedAt: now,
    }
    await this.store.table('groups').put(record.id, record)
    return record
  }

  /** Patch a group (name, avatar, members). */
  async update(id: string, patch: GroupUpdatePatch): Promise<GroupRecord> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`chat-group: group "${id}" not found`)
    const next: GroupRecord = { ...current, ...patch, updatedAt: Date.now() }
    await this.store.table('groups').put(id, next)
    return next
  }

  /** Delete a group and tear down its container agent. */
  async remove(id: string): Promise<void> {
    const handle = this.containers.get(id)
    if (handle !== undefined) {
      this.containers.delete(id)
      await handle.dispose()
    }
    await this.store.table('groups').delete(id)
  }

  // ── container session ─────────────────────────────────────────────────────

  /**
   * The group's container agent: a never-driven agent whose durable session
   * log is the shared chat record. Riding the standard agent factory gets
   * JSONL persistence and restart resume for free.
   */
  async containerAgent(groupId: string): Promise<Agent> {
    const group = this.get(groupId)
    if (group === undefined) throw new Error(`chat-group: group "${groupId}" not found`)
    const existing = this.containers.get(groupId)
    if (existing !== undefined) return existing.agent
    const live = this.ctx.agents.get(group.sessionId)
    if (live !== undefined) return live
    const handle = await this.tryResume(group.sessionId)
    this.containers.set(groupId, handle)
    this.ctx.effect(() => () => {
      if (this.containers.get(groupId) === handle) this.containers.delete(groupId)
    }, `chat-group container ${groupId}`)
    return handle.agent
  }

  private async tryResume(sessionId: SessionId): Promise<AgentHandle> {
    try {
      return await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: {} })
    } catch (error: unknown) {
      this.ctx.logger.warn('chat-group: container resume failed, creating fresh: %o', error)
      return await this.ctx.agents.create({ sessionId, agentOptions: {} })
    }
  }

  // ── orchestration ─────────────────────────────────────────────────────────

  /**
   * Append one human message and schedule the bot cascade in the background.
   * Resolves once the message is durable in the container log.
   */
  async send(groupId: string, text: string, senderName = 'me'): Promise<void> {
    const group = this.get(groupId)
    if (group === undefined) throw new Error(`chat-group: group "${groupId}" not found`)
    const container = await this.containerAgent(groupId)
    container.session.append('group/user-message', { text, senderName })
    void this.runCascade(group, { senderId: 'user', senderName, text })
      .catch(error => this.ctx.logger.error('chat-group cascade: %o', error))
  }

  /** The anti-infinite-loop cascade: each round evaluates the latest message. */
  private async runCascade(group: GroupRecord, message: TriggerMessage): Promise<void> {
    const maxRounds = this.config.maxGroupRounds ?? DEFAULT_MAX_GROUP_ROUNDS
    for (let round = 0; round < maxRounds; round++) {
      const responders: BotRecord[] = []
      for (const botId of group.memberBotIds) {
        if (botId === message.senderId) continue
        const bot = this.ctx.chatBots.get(botId)
        if (bot === undefined) continue
        const respond = shouldRespond(bot, message, {
          lastSpokeAt: this.lastSpoke.get(botId) ?? null,
          now: Date.now(),
          random: Math.random,
        })
        if (respond) responders.push(bot)
      }
      if (responders.length === 0) return

      let last: TriggerMessage | null = null
      for (const bot of responders) {
        const spoken = await this.speak(group, bot)
        if (spoken !== null) last = spoken
      }
      if (last === null) return
      message = last
    }
  }

  /** Drive one bot's group reply; returns its message for the next round. */
  private async speak(group: GroupRecord, bot: BotRecord): Promise<TriggerMessage | null> {
    const container = await this.containerAgent(group.id)
    const agent = await this.ctx.chatBots.ensureAgent(bot.id)
    const context = renderGroupContext(container.session, this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW)

    // Hidden durable context: the rendered group transcript (relay form).
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: context }],
      source: { kind: 'plugin', plugin: 'chat-group', form: 'relay' },
    }))
    // The waking turn: a notice-shaped nudge, never a fake human message.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '群聊轮到你了。请根据上面群聊记录中与你相关的内容直接给出你的回复；没有可回应的就简短回应。' }],
      source: {
        kind: 'plugin',
        plugin: 'chat-group',
        form: 'notice',
        summary: '群聊轮次',
      },
    }))
    await agent.whenIdle()

    const text = lastAssistantText(agent.session)
    if (text === null) return null
    container.session.append('group/bot-message', { botId: bot.id, botName: bot.name, text })
    this.lastSpoke.set(bot.id, Date.now())
    return { senderId: bot.id, senderName: bot.name, text }
  }

  // ── history ───────────────────────────────────────────────────────────────

  /** Render the container log as chat rows, oldest first. */
  async history(groupId: string): Promise<GroupMessageView[]> {
    const group = this.get(groupId)
    if (group === undefined) throw new Error(`chat-group: group "${groupId}" not found`)
    const container = await this.containerAgent(groupId)
    return renderHistory(container.session)
  }

  // ── HTTP surface ──────────────────────────────────────────────────────────

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

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/groups',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/groups\/([^/]+)(\/[a-z]+)?$/.exec(req.url ?? '')
          const groupId = match?.[1]
          const action = match?.[2]

          if (groupId === undefined) {
            if (req.method === 'GET') return json(res, 200, { items: this.list() })
            if (req.method === 'POST') {
              const body = await readBody(req)
              if (typeof body.name !== 'string' || body.name === '') {
                return json(res, 400, { error: 'name is required' })
              }
              const group = await this.create({
                name: body.name,
                avatar: typeof body.avatar === 'string' ? body.avatar : undefined,
                memberBotIds: Array.isArray(body.memberBotIds)
                  ? body.memberBotIds.filter((v): v is string => typeof v === 'string')
                  : undefined,
              })
              return json(res, 200, group)
            }
            return json(res, 405, { error: 'method not allowed' })
          }

          if (action === '/send') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            const body = await readBody(req)
            if (typeof body.content !== 'string' || body.content === '') {
              return json(res, 400, { error: 'content is required' })
            }
            await this.send(
              groupId,
              body.content,
              typeof body.senderName === 'string' ? body.senderName : 'me',
            )
            return json(res, 200, { accepted: true })
          }

          if (action === '/history') {
            if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
            return json(res, 200, { items: await this.history(groupId) })
          }

          if (req.method === 'GET') {
            const group = this.get(groupId)
            return group === undefined ? json(res, 404, { error: 'group not found' }) : json(res, 200, group)
          }
          if (req.method === 'PUT' || req.method === 'PATCH') {
            const group = await this.update(groupId, await readBody(req) as GroupUpdatePatch)
            return json(res, 200, group)
          }
          if (req.method === 'DELETE') {
            await this.remove(groupId)
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

// ── pure render helpers ──────────────────────────────────────────────────────

/** Render recent group events as the bot-facing relay transcript. */
function renderGroupContext(session: Session, window: number): string {
  const rows: string[] = []
  for (const event of session.events) {
    if (event.type === 'group/user-message') {
      rows.push(`${event.data.senderName}: ${event.data.text}`)
    } else if (event.type === 'group/bot-message') {
      rows.push(`${event.data.botName}: ${event.data.text}`)
    }
  }
  const recent = rows.slice(-window)
  return [
    '以下是群里最近的聊天记录（最后一条是最新消息）：',
    ...recent,
    '请以你的身份参与这个群聊。',
  ].join('\n')
}

/** The last assistant message's concatenated text blocks, or null. */
function lastAssistantText(session: Session): string | null {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event === undefined) continue
    if (event.type !== 'assistant/message') continue
    const text = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    return text === '' ? null : text
  }
  return null
}

/** Project container events to chat rows. */
function renderHistory(session: Session): GroupMessageView[] {
  const items: GroupMessageView[] = []
  for (const event of session.events) {
    if (event.type === 'group/user-message') {
      items.push({
        seq: event.seq,
        time: event.time,
        kind: 'user',
        senderId: 'user',
        senderName: event.data.senderName,
        text: event.data.text,
      })
    } else if (event.type === 'group/bot-message') {
      items.push({
        seq: event.seq,
        time: event.time,
        kind: 'bot',
        senderId: event.data.botId,
        senderName: event.data.botName,
        text: event.data.text,
      })
    }
  }
  return items
}

/** Mount the group orchestration. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ChatGroup, config)
}
