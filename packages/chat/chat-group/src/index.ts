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
import { access, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { BotRecord } from '@deepseek-ai/dsh-chat-bots'
import { buildBotAgentSetup, resolveEnabledSkills } from '@deepseek-ai/dsh-chat-bots'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls in the `webServer` Context augmentation.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Side-effect type import: pulls in the `tools` Context augmentation.
import type {} from '@deepseek-ai/dsh-tools'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { botSessionRecordSchema, groupRecordSchema } from './schema.ts'
import { shouldRespond } from './trigger.ts'
import type { TriggerMessage } from './trigger.ts'
import type { GroupCreateInput, GroupMessageView, GroupRecord, GroupUpdatePatch } from './types.ts'
import { aggregateLastRun, translateSessionEvent } from '@deepseek-ai/dsh-chat-bots/bridge'

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
  tables: {
    groups: domainTable<string, GroupRecord>(groupRecordSchema),
    // Per-(group, bot) chat sessions: a bot's group-chat memory, kept separate
    // from its private-chat session so histories never cross-contaminate.
    bot_sessions: domainTable<string, { sessionId: SessionId; createdAt: number; updatedAt: number }>(botSessionRecordSchema),
  },
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

  /** Live per-(group, bot) agent handles with the bot-record revision they were built from. */
  private readonly botAgents = new Map<string, { handle: AgentHandle; botUpdatedAt: number }>()

  /** Last group-reply time per bot id (epoch ms); in-memory cooldown state. */
  private readonly lastSpoke = new Map<string, number>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'chatGroup')
  }

  private get store(): Domain<typeof groupsDomainSpec> {
    if (this.domain === undefined) throw new Error('chat-group: domain not open')
    return this.domain
  }

  /** Reset a group: fresh container session, fresh per-bot group memories, logs removed. */
  async clear(id: string): Promise<void> {
    const group = this.get(id)
    if (group === undefined) throw new Error(`chat-group: group "${id}" not found`)
    // 释放容器与所有 bot 群会话 agent
    const container = this.containers.get(id)
    if (container !== undefined) {
      this.containers.delete(id)
      await container.dispose()
    }
    const table = this.store.table('bot_sessions')
    for (const key of [...table.entries()].map(([key]) => key)) {
      if (!key.startsWith(`${id}:`)) continue
      const binding = table.get(key)
      const cached = this.botAgents.get(key)
      if (cached !== undefined) {
        this.botAgents.delete(key)
        await cached.handle.dispose()
      }
      if (binding !== undefined) {
        await table.delete(key)
        await this.removeSessionLogs(binding.sessionId)
      }
    }
    const sessionId = `session-${randomUUID()}` as SessionId
    await this.store.table('groups').put(id, { ...group, sessionId, updatedAt: Date.now() })
    await this.removeSessionLogs(group.sessionId)
  }

  /** Remove one session's log directories under $DSH_HOME/sessions. */
  private async removeSessionLogs(sessionId: SessionId): Promise<void> {
    const sessionsRoot = join(resolveDshHome(), 'sessions')
    try {
      for (const dir of await readdir(sessionsRoot)) {
        const target = join(sessionsRoot, dir, sessionId)
        try {
          await access(target)
          await rm(target, { recursive: true, force: true })
        } catch {
          // 该 cwd 分组下无此会话
        }
      }
    } catch {
      // sessions 根不存在则无事可做
    }
  }

  async [Service.init](): Promise<void> {
    this.domain = await this.ctx.storageDomain.open(groupsDomainSpec)
    this.ctx.effect(() => () => {
      void this.domain?.close()
      this.domain = undefined
    }, 'chat-group domain')
    this.registerHttp()
    // 一次性回填：为缺少工作目录的旧群记录补建 workspace/groups/{id}
    const groups = this.domain.table('groups')
    for (const [id, group] of groups.entries()) {
      if (group.workspaceDir !== undefined) continue
      const workspaceDir = join(resolveDshHome(), 'workspace', 'groups', id)
      await mkdir(workspaceDir, { recursive: true })
      await groups.put(id, { ...group, workspaceDir, updatedAt: Date.now() })
    }
    this.registerEventBridge()
  }

  /** Broadcast one legacy-shaped event frame through the chat-bots SSE channel. */
  private broadcast(event: string, data: unknown): void {
    this.ctx.chatBots.broadcast(event, data)
  }

  /**
   * Group event bridge:
   * - container appends (`group/user-message`, `group/bot-message`) become
   *   `message.created` / `conversation.updated`;
   * - per-bot group sessions stream `message.stream` / `bot.typing` /
   *   `agent.tool.*` (their final message lands via the container append).
   */
  private registerEventBridge(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'group/user-message' && event.type !== 'group/bot-message') {
        // A per-bot group session: translate turn lifecycle into stream frames.
        const binding = this.botSessionBinding(session.id)
        if (binding === undefined) return
        const bot = this.ctx.chatBots.get(binding.botId)
        if (bot === undefined) return
        const group = this.get(binding.groupId)
        translateSessionEvent(session, event, {
          conversationId: binding.groupId,
          botId: bot.id,
          botName: bot.name,
          emitFinal: false,
          conversation: group === undefined ? undefined : {
            id: group.id,
            type: 'group',
            name: group.name,
            avatar: group.avatar ?? null,
            introduction: '',
            unread_count: 0,
            created_at: group.createdAt,
          },
        }, (name: string, data: unknown) => this.broadcast(name, data))
        return
      }

      // A container append: only groups we own.
      const group = this.list().find(record => record.sessionId === session.id)
      if (group === undefined) return
      if (event.type === 'group/user-message') {
        this.broadcast('conversation.updated', {
          id: group.id,
          type: 'group',
          name: group.name,
          avatar: group.avatar ?? null,
          introduction: '',
          last_message_preview: event.data.text.slice(0, 60),
          last_message_at: event.time,
          unread_count: 0,
          created_at: group.createdAt,
        })
        return
      }
      // group/bot-message → the durable group reply（含该次 run 的统计）
      this.broadcast('message.created', {
        id: `g-${String(event.seq)}`,
        conversation_id: group.id,
        sender_type: 'ai_bot',
        sender_id: event.data.botId,
        sender_name: event.data.botName,
        content: event.data.text,
        content_type: 'text',
        is_self: 0,
        created_at: event.time,
        segments: event.data.segments ?? [{ type: 'text', content: event.data.text }],
        tool_calls: event.data.toolCalls,
        prompt_tokens: event.data.promptTokens ?? 0,
        completion_tokens: event.data.completionTokens ?? 0,
        cached_tokens: event.data.cachedTokens ?? 0,
        duration_ms: event.data.durationMs ?? 0,
        stop_reason: '',
      })
      this.broadcast('conversation.updated', {
        id: group.id,
        type: 'group',
        name: group.name,
        avatar: group.avatar ?? null,
        introduction: '',
        last_message_preview: event.data.text.slice(0, 60),
        last_message_at: event.time,
        unread_count: 0,
        created_at: group.createdAt,
      })
    })
  }

  /** Resolve a session id back to its (group, bot) binding, if we own it. */
  private botSessionBinding(sessionId: SessionId): { groupId: string; botId: string } | undefined {
    for (const [key, record] of this.store.table('bot_sessions').entries()) {
      if (record.sessionId !== sessionId) continue
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      return { groupId: key.slice(0, separator), botId: key.slice(separator + 1) }
    }
    return undefined
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
    const id = `group-${randomUUID()}`
    // 每个群固定工作目录：$DSH_HOME/workspace/groups/{uid}
    const workspaceDir = join(resolveDshHome(), 'workspace', 'groups', id)
    const record: GroupRecord = {
      name: input.name,
      avatar: input.avatar,
      memberBotIds: input.memberBotIds ?? [],
      id,
      sessionId: `session-${randomUUID()}` as SessionId,
      workspaceDir,
      createdAt: now,
      updatedAt: now,
    }
    await mkdir(workspaceDir, { recursive: true })
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
    const handle = await this.tryResume(group.sessionId, group.workspaceDir)
    this.containers.set(groupId, handle)
    this.ctx.effect(() => () => {
      if (this.containers.get(groupId) === handle) this.containers.delete(groupId)
    }, `chat-group container ${groupId}`)
    return handle.agent
  }

  private async tryResume(sessionId: SessionId, cwd?: string): Promise<AgentHandle> {
    try {
      return await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions: {} })
    } catch (error: unknown) {
      this.ctx.logger.warn('chat-group: container resume failed, creating fresh: %o', error)
      return await this.ctx.agents.create(cwd === undefined
        ? { sessionId, agentOptions: {} }
        : { sessionId, meta: { cwd }, agentOptions: {} })
    }
  }

  /**
   * The bot's dedicated group-chat agent on its own persistent session —
   * separate from the bot's private-chat memory. Rebuilt when the bot record
   * (persona/model) changes; resumed across restarts otherwise.
   */
  private async ensureBotAgent(group: GroupRecord, bot: BotRecord): Promise<Agent> {
    const key = `${group.id}:${bot.id}`
    const cached = this.botAgents.get(key)
    if (cached !== undefined && cached.botUpdatedAt === bot.updatedAt) {
      return cached.handle.agent
    }
    if (cached !== undefined) {
      this.botAgents.delete(key)
      await cached.handle.dispose()
    }

    const table = this.store.table('bot_sessions')
    let binding = table.get(key)
    if (binding === undefined) {
      const now = Date.now()
      binding = { sessionId: `session-${randomUUID()}` as SessionId, createdAt: now, updatedAt: now }
      await table.put(key, binding)
    }

    const agentOptions = { provider: bot.provider, model: bot.model }
    // 与私聊共用同一套能力装配：persona、Agent 开关三重防线、工具白名单、
    // 启用技能目录 + scoped `skill` 工具（群聊沿用 bot 自己的工作区围栏）。
    const skillSummaries = await resolveEnabledSkills(this.ctx, bot)
    const setup = buildBotAgentSetup(this.ctx, bot, skillSummaries)
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: binding.sessionId, agentOptions, setup })
    } catch {
      handle = await this.ctx.agents.create(bot.workspaceDir === undefined
        ? { sessionId: binding.sessionId, agentOptions, setup }
        : { sessionId: binding.sessionId, meta: { cwd: bot.workspaceDir }, agentOptions, setup })
    }
    this.botAgents.set(key, { handle, botUpdatedAt: bot.updatedAt })
    this.ctx.effect(() => () => {
      if (this.botAgents.get(key)?.handle === handle) this.botAgents.delete(key)
    }, `chat-group bot agent ${key}`)
    return handle.agent
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
    // 首条消息若 @ 了成员，只有被 @ 的成员回复该消息（旧版群聊语义）
    const mentionedBotIds = new Set(
      group.memberBotIds.filter((botId) => {
        const bot = this.ctx.chatBots.get(botId)
        return bot !== undefined && message.text.includes(`@${bot.name}`)
      }),
    )
    const hasMention = mentionedBotIds.size > 0

    for (let round = 0; round < maxRounds; round++) {
      const responders: BotRecord[] = []
      for (const botId of group.memberBotIds) {
        if (botId === message.senderId) continue
        if (round === 0 && hasMention && !mentionedBotIds.has(botId)) continue
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
    const agent = await this.ensureBotAgent(group, bot)
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
    // 聚合该次 run 的统计（usage/segments/工具调用/时长）随事件落库，
    // 群聊气泡的统计行与刷新后的历史渲染都从这里取
    const run = aggregateLastRun(agent.session, bot.id, bot.name)
    const appendData: {
      botId: string
      botName: string
      text: string
      promptTokens?: number
      completionTokens?: number
      cachedTokens?: number
      durationMs?: number
      segments?: Array<{ type: 'reasoning' | 'text' | 'tool'; content: string; toolId?: string }>
      toolCalls?: Array<{
        id: string
        name: string
        args?: unknown
        result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
        isError?: boolean
      }>
    } = { botId: bot.id, botName: bot.name, text }
    if (run !== undefined) {
      appendData.promptTokens = run.promptTokens
      appendData.completionTokens = run.completionTokens
      appendData.cachedTokens = run.cachedTokens
      appendData.durationMs = run.durationMs
      appendData.segments = run.segments
      appendData.toolCalls = run.toolCalls
    }
    container.session.append('group/bot-message', appendData)
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
    // ── misc：群会话预览（会话列表最后一行）──
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/group-misc',
      handler: async (req, res) => {
        const json = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        try {
          if (req.method !== 'POST') return json(405, { error: 'method not allowed' })
          const body = await readBody(req)
          if (String(body.action ?? '') !== 'conversation-previews') {
            return json(404, { error: 'unknown action' })
          }
          const previews: Record<string, { preview: string; at: number }> = {}
          for (const group of this.list()) {
            try {
              const container = await this.containerAgent(group.id)
              const rows = renderHistory(container.session)
              const last = rows.at(-1)
              if (last !== undefined) previews[group.id] = { preview: last.text.slice(0, 60), at: last.time }
            } catch {
              // 容器恢复失败的群跳过预览
            }
          }
          return json(200, { previews })
        } catch (error: unknown) {
          return json(500, { error: String(error) })
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

          if (action === '/clear') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            await this.clear(groupId)
            // 通知前端清除该会话的全部本地状态（含流式残留）
            this.ctx.chatBots.broadcast('message.cleared', { conversationId: groupId })
            return json(res, 200, { cleared: true })
          }

          if (action === '/stop') {
            if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
            // 取消容器 agent（编排循环）与该群全部成员 bot agent（各自的
            // 生成 turn），清空后续轮次调度
            let stopped = false
            const container = this.containers.get(groupId)?.agent
            if (container !== undefined && container.status === 'running') {
              container.cancel({ kind: 'user' })
              stopped = true
            }
            for (const [key, entry] of this.botAgents) {
              if (!key.startsWith(`${groupId}:`)) continue
              const agent = entry.handle.agent
              if (agent.status === 'running') {
                agent.cancel({ kind: 'user' })
                stopped = true
              }
            }
            return json(res, 200, { ok: true, stopped })
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
        ...(event.data.segments !== undefined ? { segments: event.data.segments } : {}),
        ...(event.data.toolCalls !== undefined ? { toolCalls: event.data.toolCalls } : {}),
        ...(event.data.promptTokens !== undefined ? { promptTokens: event.data.promptTokens } : {}),
        ...(event.data.completionTokens !== undefined ? { completionTokens: event.data.completionTokens } : {}),
        ...(event.data.cachedTokens !== undefined ? { cachedTokens: event.data.cachedTokens } : {}),
        ...(event.data.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
      })
    }
  }
  return items
}

/** Mount the group orchestration. */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(ChatGroup, config)
}
