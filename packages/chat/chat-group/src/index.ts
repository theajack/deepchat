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
import { botSessionRecordSchema, groupRecordSchema, settingValueSchema } from './schema.ts'
import { scheduleSpeakers } from './scheduler.ts'
import type { TriggerMessage } from './trigger.ts'
import { appendFile } from 'node:fs/promises'

/**
 * TEMPORARY troubleshooting trace — will be removed once the cascade gap is confirmed.
 *
 * Writes to `$DSH_HOME/logs/group-trace.log` because `ctx.logger.info/warn`
 * does not reach debug.log (same issue as memory consolidation).
 * Also writes to stderr so logs are always visible in the terminal.
 */
async function traceGroup(message: string): Promise<void> {
  // Always write to stderr — guaranteed visible in tauri dev terminal
  process.stderr.write(`[group-trace] ${message}\n`)
  try {
    const dir = join(resolveDshHome(), 'logs')
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, 'group-trace.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch { /* never block */ }
}
import type { GroupCreateInput, GroupMessageView, GroupRecord, GroupUpdatePatch } from './types.ts'
import { aggregateLastRun, pageRows, translateSessionEvent } from '@deepseek-ai/dsh-chat-bots/bridge'
import { extractTranscript, routeIdFor, type MemorySourceRow } from '@deepseek-ai/dsh-chat-bots'

export type {
  GroupCreateInput,
  GroupMessageView,
  GroupRecord,
  GroupUpdatePatch,
} from './types.ts'
export { shouldRespond } from './trigger.ts'
export type { TriggerContext, TriggerMessage } from './trigger.ts'
export { parseSpeakerIds, scheduleSpeakers } from './scheduler.ts'
export type { ScheduleCandidate, ScheduleRequest } from './scheduler.ts'

/** Cordis plugin name. */
export const name = 'chat-group'

/**
 * Bot registry, agent registry, the LLM seam (the speaker scheduler calls it
 * directly), tool registry (`buildBotAgentSetup` reads `ctx.tools.schemas()`
 * for the per-bot tool whitelist — omitting it throws "cannot get property
 * \"tools\" without inject" the moment a bot with a non-empty whitelist is
 * woken, silently killing that member's turn), skill registry
 * (`resolveEnabledSkills` snapshots `ctx.skills`, and the scoped `skill`
 * loader tool resolves `ctx.skills.get` at call time), storage domain, and
 * the HTTP carrier are required.
 */
export const inject = ['chatBots', 'agents', 'llm', 'tools', 'skills', 'storageDomain', 'webServer', 'fs']

/** Plugin config. */
export interface Config {
  /** Round cap for one human message's AI→AI cascade (anti-infinite-loop). */
  readonly maxGroupRounds?: number
  /** Recent group messages rendered into each bot's relay context. */
  readonly contextWindow?: number
  /** How many bots the scheduler may pick in one round. */
  readonly maxSpeakersPerRound?: number
  /**
   * Force one bot to speak when the scheduler picks nobody.
   * Off by default: the whole point is letting the AI decide to stay quiet.
   */
  readonly fallbackEnabled?: boolean
  /**
   * Whether the scheduling model arbitrates who speaks each round.
   *
   * On (default) the scheduler reads the transcript plus every candidate's
   * persona and decides who should answer, and stays quiet when nobody
   * should. Off, the first eligible member simply answers every time — no
   * arbitration call and no "thinking" pause, at the cost of far less
   * natural turn-taking. This is the static default; the UI toggle is stored
   * in the domain's `settings` table and overrides it.
   */
  readonly schedulerEnabled?: boolean
}

const DEFAULT_MAX_GROUP_ROUNDS = 3
const DEFAULT_CONTEXT_WINDOW = 20
const DEFAULT_MAX_SPEAKERS_PER_ROUND = 1

/**
 * Hard cap on how many members may answer one message.
 *
 * One voice per turn is a deliberate product decision: letting several bots
 * pile onto the same message makes the group read like a monologue of
 * overlapping replies and burns through the round budget almost instantly.
 * Configuration may lower this (to 0) but never raise it.
 */
const MAX_SPEAKERS_PER_ROUND_CAP = 1

/**
 * How often the idle auto-speak tick scans the groups.
 *
 * 30s is coarse enough to be free and fine enough that a "5 minutes of
 * silence" promise never overshoots by a noticeable margin.
 */
const IDLE_CHECK_INTERVAL_MS = 30_000

/**
 * Idle window (minutes) used when a bot enabled auto-speak but carries no
 * explicit value — the middle of the 5–10 range the UI defaults into.
 */
const DEFAULT_IDLE_TRIGGER_MINUTES = 7

export const Config: z<Config> = z.object({
  maxGroupRounds: z.natural().default(DEFAULT_MAX_GROUP_ROUNDS),
  contextWindow: z.natural().default(DEFAULT_CONTEXT_WINDOW),
  maxSpeakersPerRound: z.natural().default(DEFAULT_MAX_SPEAKERS_PER_ROUND),
  fallbackEnabled: z.boolean().default(false),
  schedulerEnabled: z.boolean().default(true),
})

/** Storage key for the user-facing "scheduler decides who speaks" toggle. */
const SCHEDULER_ENABLED_KEY = 'scheduler_enabled'

/** The durable group-record storage domain. */
const groupsDomainSpec = defineDomain({
  name: 'chat_groups',
  version: 1,
  tables: {
    groups: domainTable<string, GroupRecord>(groupRecordSchema),
    // Per-(group, bot) chat sessions: a bot's group-chat memory, kept separate
    // from its private-chat session so histories never cross-contaminate.
    bot_sessions: domainTable<string, { sessionId: SessionId; createdAt: number; updatedAt: number }>(botSessionRecordSchema),
    // Domain-wide settings, keyed by name. Values are plain strings so adding
    // a setting later never needs a schema migration.
    settings: domainTable<string, string>(settingValueSchema),
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

  /**
   * Last activity time per group id (epoch ms) — the baseline the idle
   * auto-speak tick measures silence against. Seeded on first sight so a
   * freshly loaded group does not fire immediately.
   */
  private readonly groupActivity = new Map<string, number>()

  /** Groups with a cascade in flight; the idle tick leaves them alone. */
  private readonly cascading = new Set<string>()

  /**
   * Who last broke the silence in each group, and when. Stops one bot from
   * monologuing at itself: after an unprompted turn nobody answered, the same
   * bot is skipped next time and the group is allowed to stay quiet.
   */
  private readonly lastIdleTurn = new Map<string, { botId: string; at: number }>()

  /**
   * Groups the user has asked to stop.
   *
   * Cancelling the running turn alone is not enough: the cascade would just
   * schedule the next member and the conversation would never end. This flag
   * is what actually breaks the loop — checked before each speaker and
   * between rounds, and cleared by the user's next message.
   */
  private readonly stopped = new Set<string>()

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
    // 清空前为每个成员 bot 快照群聊对话并异步沉淀进长期记忆（不阻塞清空）。
    // 快照必须在删除会话日志之前完成——rows 是普通数组，之后就与会话无关了。
    await this.snapshotMemberMemories(id)
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

  /**
   * Snapshot every member bot's group conversation and hand it to chat-bots for
   * long-term memory consolidation (fire-and-forget).
   *
   * Group transcripts live in per-(group, bot) sessions that are about to be
   * deleted, so the rows must be lifted into memory first. Each bot gets one
   * shared memory document: experiences from every group merge into the same
   * file as its private chats.
   */
  private async snapshotMemberMemories(groupId: string): Promise<void> {
    const table = this.store.table('bot_sessions')
    const keys = [...table.entries()].map(([key]) => key).filter(key => key.startsWith(`${groupId}:`))
    for (const key of keys) {
      const separator = key.indexOf(':')
      if (separator <= 0) continue
      const botId = key.slice(separator + 1)
      const bot = this.ctx.chatBots.get(botId)
      if (bot === undefined) continue
      // Prefer the live agent so we do not pay for a resume.
      const cached = this.botAgents.get(key)
      let rows: readonly MemorySourceRow[] | undefined
      if (cached !== undefined) {
        rows = extractTranscript(cached.handle.agent.session)
      } else {
        const binding = table.get(key)
        if (binding === undefined) continue
        const handle = await this.tryResume(binding.sessionId)
        try {
          rows = extractTranscript(handle.agent.session)
        } finally {
          await handle.dispose()
        }
      }
      if (rows !== undefined && rows.length > 0) this.ctx.chatBots.consolidateBotMemory(bot, rows)
    }
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
    this.startIdleTrigger()
  }

  /** Broadcast one legacy-shaped event frame through the chat-bots SSE channel. */
  private broadcast(event: string, data: unknown): void {
    this.ctx.chatBots.broadcast(event, data)
  }

  /**
   * Tell the UI the group is deciding who speaks next, so it can show a
   * "members are thinking" placeholder while the scheduler runs.
   */
  private broadcastScheduling(groupId: string, active: boolean): void {
    this.broadcast('group.scheduling', { conversationId: groupId, active })
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
    // 群工作目录：用户指定优先，否则用 $DSH_HOME/workspace/groups/{uid}
    const requested = input.workspaceDir?.trim()
    const workspaceDir = requested !== undefined && requested !== ''
      ? requested
      : join(resolveDshHome(), 'workspace', 'groups', id)
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
    // 必须真实存在：agent 的沙箱 cwd 与文件工具都以它为根，指向不存在的
    // 路径会让成员一开口就报错。
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
    this.groupActivity.set(group.id, Date.now())
    // 用户重新开口即解除上一次的停止，否则此后该群永远不会再有 AI 回应
    this.stopped.delete(group.id)
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

    // 占用该群：空闲触发器会跳过正在说话的群，避免两段对话交错重叠
    this.cascading.add(group.id)
    try {
      await this.cascadeRounds(group, message, maxRounds, hasMention, mentionedBotIds)
    } finally {
      this.cascading.delete(group.id)
      // 兜底：任何退出路径都必须关掉指示器，否则群里会一直挂着"思考中"
      this.broadcastScheduling(group.id, false)
    }
  }

  /**
   * The cascade loop: each round asks the scheduler who should speak next,
   * then lets them speak, then feeds the result back in as the new latest
   * message. Stops when nobody is chosen, nobody actually speaks, or the
   * round budget is spent.
   */
  private async cascadeRounds(
    group: GroupRecord,
    message: TriggerMessage,
    maxRounds: number,
    hasMention: boolean,
    mentionedBotIds: ReadonlySet<string>,
  ): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      // 用户点了停止：不再发起新一轮调度，对话到此为止
      if (this.stopped.has(group.id)) {
        await traceGroup(`ROUND ${round}: STOPPED by user → cascade aborts`)
        return
      }
      await traceGroup(`=== ROUND ${round} | sender=${message.senderId} text="${message.text.slice(0, 80)}" ===`)
      // 每一轮调度都单独显示一次"思考中"：AI 接话后还会再决策一次要不要
      // 有人接着说，这个过程同样需要反馈，否则用户会以为卡住了。
      const responders = await this.scheduleRound(group, message, round, hasMention, mentionedBotIds)
      await traceGroup(`ROUND ${round}: responders=${responders.length} [${responders.map(b => b.id).join(',')}]`)
      if (responders.length === 0) {
        await traceGroup(`ROUND ${round}: EMPTY → cascade ends`)
        return
      }

      const last = await this.speakResponders(group, responders)
      // 停止可能在发言过程中发生（speak 内部会提前返回），这里再确认一次
      if (this.stopped.has(group.id)) {
        await traceGroup(`ROUND ${round}: STOPPED by user after speaking → cascade aborts`)
        return
      }
      if (last === null) {
        await traceGroup(`ROUND ${round}: last=null → cascade ends`)
        return
      }
      message = last
    }
    await traceGroup('cascade finished (max rounds reached)')
  }

  /**
   * One scheduler decision, wrapped in the group's "thinking..." indicator.
   *
   * The indicator covers exactly the LLM call that decides who speaks — it
   * turns on when the decision starts and off the moment the answer lands.
   * The speaking that follows is driven by `bot.typing` / the streaming draft
   * instead, so the two never overlap into one long, undifferentiated wait.
   */
  private async scheduleRound(
    group: GroupRecord,
    message: TriggerMessage,
    round: number,
    hasMention: boolean,
    mentionedBotIds: ReadonlySet<string>,
  ): Promise<BotRecord[]> {
    this.broadcastScheduling(group.id, true)
    try {
      return await this.selectResponders(group, message, round, hasMention, mentionedBotIds)
    } finally {
      this.broadcastScheduling(group.id, false)
    }
  }

  /** Serially speak each responder in order and return the final spoken message. */
  private async speakResponders(group: GroupRecord, responders: BotRecord[]): Promise<TriggerMessage | null> {
    let last: TriggerMessage | null = null
    for (const bot of responders) {
      // 用户已停止：跳过尚未开口的成员
      if (this.stopped.has(group.id)) {
        await traceGroup(`speakResponders: STOPPED → skipping bot=${bot.id}`)
        break
      }
      await traceGroup(`speakResponders: bot=${bot.id}`)
      try {
        const spoken = await this.speak(group, bot)
        await traceGroup(`speakResponders: bot=${bot.id} result=${spoken === null ? 'NULL' : 'OK'}`)
        if (spoken !== null) last = spoken
      } catch (error: unknown) {
        await traceGroup(`speakResponders: bot=${bot.id} THREW ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return last
  }

  /**
   * Pick who speaks next: the scheduler decides, the rule engine is the
   * fallback for when it cannot be consulted.
   *
   * Responders are ordered — the cascade speaks them serially, so a later bot
   * sees what the earlier one just said and can genuinely build on it.
   */
  private async selectResponders(
    group: GroupRecord,
    message: TriggerMessage,
    round: number,
    hasMention: boolean,
    mentionedBotIds: ReadonlySet<string>,
  ): Promise<BotRecord[]> {
    // Hard constraints, no model involved: the sender never replies to itself,
    // and a mention only obliges the mentioned bots on the first round.
    const eligible = group.memberBotIds
      .filter(botId => botId !== message.senderId)
      .filter(botId => !(round === 0 && hasMention && !mentionedBotIds.has(botId)))
      .map(botId => this.ctx.chatBots.get(botId))
      .filter((bot): bot is BotRecord => bot !== undefined)

    // A mention is an unconditional obligation.
    const forced = eligible.filter(bot => message.text.includes(`@${bot.name}`))

    // Everyone else is a scheduler candidate: any member may be chosen to
    // answer what someone else just said.
    //
    // `autoSpeak` deliberately does NOT gate this. It only governs breaking a
    // silence on one's own (the idle trigger) — a member that never speaks
    // unprompted must still be able to hold up its side of the conversation
    // once spoken to, otherwise the new default (off) would mute everyone.
    //
    // The old cooldown gate is gone with it: the UI no longer exposes a
    // cooldown, so keeping it would silently cut conversations short using a
    // value nobody can see or change.
    const candidates = eligible.filter(bot => !forced.includes(bot))

    await traceGroup(`selectResponders: eligible=${eligible.length} forced=${forced.length} candidates=${candidates.length} [${candidates.map(b => b.id).join(',')}]`)

    const scheduled = await this.runScheduler(group, candidates, message)
    // Belt-and-suspenders: the scheduler's parseSpeakerIds already validates
    // against the candidate whitelist, but the caller may also pass a
    // TriggerMessage whose senderId is a bot (cascade round ≥ 1). Filter one
    // more time so a bot can never end up in its own responder list.
    //
    // One speaker per turn, even when several members were @-mentioned: the
    // rest get their turn in the following cascade rounds rather than all
    // talking over the same message at once.
    const all = [...forced, ...scheduled].filter(bot => bot.id !== message.senderId)
    const responders = all.slice(0, MAX_SPEAKERS_PER_ROUND_CAP)

    await traceGroup(`selectResponders: RESULT forced=${forced.length} scheduled=${scheduled.length} picked=${responders.length}/${all.length} [${responders.map(b => b.id).join(',')}]`)
    if (responders.length > 0) return responders

    // Nobody chose to speak. With the fallback off (default) that is a valid
    // outcome — the group simply stays quiet.
    if (this.config.fallbackEnabled !== true) return []
    const fallback = candidates[0] ?? eligible.find(bot => !forced.includes(bot))
    return fallback === undefined ? [] : [fallback]
  }

  /**
   * One scheduling call over the candidate pool.
   *
   * Falls back to the probability rule engine when no scheduling model is
   * configured, or when the call fails — availability beats intelligence here.
   */
  private async runScheduler(group: GroupRecord, candidates: BotRecord[], message: TriggerMessage): Promise<BotRecord[]> {
    if (candidates.length === 0) return []
    const maxSpeakers = Math.min(
      this.config.maxSpeakersPerRound ?? DEFAULT_MAX_SPEAKERS_PER_ROUND,
      MAX_SPEAKERS_PER_ROUND_CAP,
    )
    if (maxSpeakers <= 0) return []

    // 关闭发言调度者：不做判断，直接由排在最前的候选成员接话。省掉一次
    // 仲裁调用与"思考中"的停顿，代价是接话不再看人设与语境。
    if (!this.schedulerEnabled()) {
      await traceGroup(`runScheduler: DISABLED → first candidate [${candidates[0]?.id ?? ''}]`)
      return candidates.slice(0, maxSpeakers)
    }

    const model = this.ctx.chatBots.groupJudgeModel()
    await traceGroup(`runScheduler: model=${model?.id ?? 'NONE'} candidateIds=[${candidates.map(b => b.id).join(',')}]`)
    if (model !== undefined) {
      try {
        const container = await this.containerAgent(group.id)
        const now = Date.now()
        const ids = await scheduleSpeakers({
          ctx: this.ctx,
          groupName: group.name,
          transcript: renderTranscript(container.session, this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
          // 发言人不在候选里，模型必须知道是谁在说话，否则容易选它或判定无人回应
          lastSpeakerName: message.senderName ?? (message.senderId === 'user' ? '用户' : '另一位成员'),
          candidates: candidates.map((bot) => {
            const lastSpokeAt = this.lastSpoke.get(bot.id)
            return {
              id: bot.id,
              name: bot.name,
              persona: bot.persona,
              topics: bot.trigger.keywords,
              silentForSeconds: lastSpokeAt === undefined ? null : (now - lastSpokeAt) / 1000,
            }
          }),
          maxSpeakers,
          provider: routeIdFor(model.id),
          model: model.modelName,
        })
        const byId = new Map(candidates.map(bot => [bot.id, bot]))
        // Log each ID mapping to detect mismatches
        for (const id of ids) {
          const found = byId.has(id)
          await traceGroup(`runScheduler: id mapping "${id}" → ${found ? 'FOUND' : 'MISSING in candidates'}`)
        }
        const mapped = ids.map(id => byId.get(id)).filter((bot): bot is BotRecord => bot !== undefined)
        await traceGroup(`runScheduler: raw=[${ids.join(',')}] mapped=${mapped.length} [${mapped.map(b => b.id).join(',')}]`)
        return mapped
      } catch (error: unknown) {
        await traceGroup(`runScheduler: THREW ${error instanceof Error ? error.message : String(error)}`)
        this.ctx.logger.warn('chat-group: scheduling failed, falling back to rules: %o', error)
      }
    }

    return candidates.slice(0, maxSpeakers)
  }

  /**
   * Drive one bot's group reply; returns its message for the next round.
   *
   * @param mode - `'reply'` when answering what someone just said (the normal
   * cascade case); `'idle'` when the bot is breaking a silence on its own, in
   * which case the nudge asks it to start something rather than to respond.
   */
  private async speak(
    group: GroupRecord,
    bot: BotRecord,
    mode: 'reply' | 'idle' = 'reply',
  ): Promise<TriggerMessage | null> {
    await traceGroup(`speak(${bot.id}): start`)
    // 成员的记忆总结（清空会话触发）未落地前先等：蒸馏结果要先进它的
    // system prompt，否则这次发言对刚沉淀的关系一无所知。
    await this.ctx.chatBots.whenMemorySettled(bot.id)
    let container: Awaited<ReturnType<typeof this.containerAgent>>
    try {
      container = await this.containerAgent(group.id)
    } catch (e) {
      await traceGroup(`speak(${bot.id}): containerAgent THREW ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    let agent: Awaited<ReturnType<typeof this.ensureBotAgent>>
    try {
      agent = await this.ensureBotAgent(group, bot)
    } catch (e) {
      await traceGroup(`speak(${bot.id}): ensureBotAgent THREW ${e instanceof Error ? e.message : String(e)}`)
      throw e
    }
    const context = renderGroupContext(
      container.session,
      this.config.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      // 告知成员可用的工作区：群共享目录 + 自己的私有目录，由它按任务自选
      { groupWorkspaceDir: group.workspaceDir, selfWorkspaceDir: bot.workspaceDir },
    )

    // Hidden durable context: the rendered group transcript (relay form).
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: context }],
      source: { kind: 'plugin', plugin: 'chat-group', form: 'relay' },
    }))
    // The waking turn: a notice-shaped nudge, never a fake human message.
    const nudge = mode === 'idle'
      ? '群里已经安静了一段时间。现在轮到你主动开口：以你的性格起一个新话题、分享一个想法、或者向其他成员提问，让群聊继续下去。不要复述上面的记录，直接说你想说的话。'
      : '群聊轮到你了。请根据上面群聊记录中与你相关的内容直接给出你的回复；没有可回应的就简短回应。'
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: nudge }],
      source: {
        kind: 'plugin',
        plugin: 'chat-group',
        form: 'notice',
        summary: '群聊轮次',
      },
    }))
    await traceGroup(`speak(${bot.id}): followup sent, waiting whenIdle...`)
    await agent.whenIdle()
    await traceGroup(`speak(${bot.id}): whenIdle resolved, checking lastAssistantText`)

    const text = lastAssistantText(agent.session)
    if (text === null) {
      await traceGroup(`speak(${bot.id}): lastAssistantText returned NULL — bot produced no text`)
      return null
    }
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
    this.groupActivity.set(group.id, Date.now())
    return { senderId: bot.id, senderName: bot.name, text }
  }

  // ── settings ──────────────────────────────────────────────────────────────

  /**
   * Whether the scheduling model arbitrates who speaks.
   *
   * The persisted UI toggle wins; otherwise the plugin's static config
   * decides, defaulting to on.
   */
  schedulerEnabled(): boolean {
    const stored = this.store.table('settings').get(SCHEDULER_ENABLED_KEY)
    if (stored !== undefined) return stored === '1'
    return this.config.schedulerEnabled ?? true
  }

  /** Persist the user's "scheduler decides who speaks" choice. */
  async setSchedulerEnabled(enabled: boolean): Promise<void> {
    await this.store.table('settings').put(SCHEDULER_ENABLED_KEY, enabled ? '1' : '0')
  }

  // ── idle auto-speak ───────────────────────────────────────────────────────

  /**
   * Start the tick that lets `autoSpeak` bots break a group's silence.
   *
   * The timer is unref'd so it can never keep the host process alive on its
   * own, and the enclosing effect clears it when the plugin is disposed.
   */
  private startIdleTrigger(): void {
    const timer = setInterval(() => {
      void this.checkIdleGroups().catch((error: unknown) => {
        this.ctx.logger.warn('chat-group idle tick: %o', error)
      })
    }, IDLE_CHECK_INTERVAL_MS)
    timer.unref?.()
    this.ctx.effect(() => () => clearInterval(timer), 'chat-group idle trigger')
  }

  /**
   * Wake one bot in every group that has been quiet past that bot's idle
   * window, then hand the conversation to the normal cascade so the other
   * members can respond.
   */
  private async checkIdleGroups(): Promise<void> {
    const now = Date.now()
    for (const group of this.list()) {
      // A cascade in flight is already producing messages; leave it alone.
      if (this.cascading.has(group.id)) continue
      // 用户已停止该群：不再主动开口
      if (this.stopped.has(group.id)) continue
      const lastAt = this.groupActivity.get(group.id)
      // A group we have not seen this run: seed the baseline instead of
      // firing immediately, otherwise every restart would dump an unprompted
      // message into every group that was idle while the app was closed.
      if (lastAt === undefined) {
        this.groupActivity.set(group.id, now)
        continue
      }
      const bot = this.pickIdleSpeaker(group, now, lastAt)
      if (bot === undefined) continue
      await traceGroup(`idle: group=${group.id} quiet ${String(Math.round((now - lastAt) / 1000))}s → waking bot=${bot.id}`)
      await this.runIdleTurn(group, bot)
    }
  }

  /**
   * The member that should break this group's silence, or undefined.
   *
   * Picks the most overdue eligible bot (the one past its window by the
   * largest margin) so a 5-minute bot speaks before a 10-minute one rather
   * than the group waiting for its slowest member.
   */
  private pickIdleSpeaker(group: GroupRecord, now: number, lastAt: number): BotRecord | undefined {
    const lastIdle = this.lastIdleTurn.get(group.id)
    let best: { bot: BotRecord; overdueBy: number } | undefined
    for (const botId of group.memberBotIds) {
      const bot = this.ctx.chatBots.get(botId)
      if (bot === undefined) continue
      // Auto-speak is opt-in; the default is to stay quiet unless addressed.
      if (bot.trigger.autoSpeak !== true) continue
      const windowMs = (bot.trigger.idleTriggerMinutes ?? DEFAULT_IDLE_TRIGGER_MINUTES) * 60_000
      const overdueBy = now - lastAt - windowMs
      if (overdueBy < 0) continue
      // Nobody replied to this bot's last unprompted turn — do not let it
      // keep talking to itself.
      if (lastIdle !== undefined && lastIdle.botId === bot.id && lastIdle.at >= lastAt) continue
      if (best === undefined || overdueBy > best.overdueBy) best = { bot, overdueBy }
    }
    return best?.bot
  }

  /**
   * Run one bot's unprompted turn, then let the cascade carry the thread on.
   *
   * The opening turn is not a scheduling decision — the idle timer picked
   * this bot, not the model — so it runs without the "thinking..." indicator.
   * Every round after it (who, if anyone, answers) does go through the
   * scheduler and therefore does show the indicator.
   */
  private async runIdleTurn(group: GroupRecord, bot: BotRecord): Promise<void> {
    this.cascading.add(group.id)
    try {
      const spoken = await this.speak(group, bot, 'idle')
      if (spoken === null) return
      this.lastIdleTurn.set(group.id, { botId: bot.id, at: Date.now() })
      const maxRounds = this.config.maxGroupRounds ?? DEFAULT_MAX_GROUP_ROUNDS
      await this.cascadeRounds(group, spoken, maxRounds, false, new Set())
    } catch (error: unknown) {
      this.ctx.logger.warn('chat-group idle turn: %o', error)
    } finally {
      this.cascading.delete(group.id)
      this.broadcastScheduling(group.id, false)
    }
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

    // 群聊级设置（不属于某个具体群，单独挂一个 prefix，避免与
    // `/chatapi/groups/{id}` 的 id 段冲突）
    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/group-settings',
      handler: async (_req, res) => {
        try {
          if (_req.method === 'GET') {
            return json(res, 200, { schedulerEnabled: this.schedulerEnabled() })
          }
          if (_req.method === 'PUT' || _req.method === 'POST') {
            const body = await readBody(_req)
            if (typeof body.schedulerEnabled !== 'boolean') {
              return json(res, 400, { error: 'schedulerEnabled must be a boolean' })
            }
            await this.setSchedulerEnabled(body.schedulerEnabled)
            return json(res, 200, { schedulerEnabled: this.schedulerEnabled() })
          }
          return json(res, 405, { error: 'method not allowed' })
        } catch (error: unknown) {
          return json(res, 500, { error: String(error) })
        }
      },
    })

    this.ctx.webServer.register({
      kind: 'prefix',
      path: '/chatapi/groups',
      handler: async (req, res) => {
        try {
          const match = /^\/chatapi\/groups\/([^/]+)(\/[a-z]+)?(?=\?|$)/.exec((req.url ?? '').split('?')[0] ?? '')
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
                // 前端按 snake_case 发 workspace_dir，驼峰也一并接受
                workspaceDir: typeof body.workspaceDir === 'string'
                  ? body.workspaceDir
                  : typeof body.workspace_dir === 'string' ? body.workspace_dir : undefined,
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
            // 用户点了停止：既要中断当前正在生成的成员，也要阻止后续轮次的
            // 调度——否则取消掉当前 turn 后循环会立刻安排下一位继续说，群聊
            // 看起来就永远停不下来。用户下一次发言时该标记会被清除。
            this.stopped.add(groupId)
            // 取消容器 agent（编排循环）与该群全部成员 bot agent（各自的生成 turn）
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
            // 游标分页：?before=<seq> 取更早的一页，?limit=N 页大小（默认 50）
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams
            const raw = query.get('before')
            const before = raw !== null && /^\d+$/.test(raw) ? Number(raw) : undefined
            const rawLimit = query.get('limit')
            const limit = rawLimit !== null && /^\d+$/.test(rawLimit)
              ? Math.min(Math.max(Number(rawLimit), 1), 200)
              : 50
            const page = pageRows(await this.history(groupId), before, limit)
            return json(res, 200, { items: page.items, hasMore: page.hasMore })
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
/** Render the recent group transcript as plain `name: text` rows. */
function renderTranscript(session: Session, window: number): string {
  const rows: string[] = []
  for (const event of session.events) {
    if (event.type === 'group/user-message') {
      rows.push(`${event.data.senderName}: ${event.data.text}`)
    } else if (event.type === 'group/bot-message') {
      rows.push(`${event.data.botName}: ${event.data.text}`)
    }
  }
  return rows.slice(-window).join('\n')
}

/**
 * Render the per-turn context handed to a member before it speaks.
 *
 * @param workspaces - Directories the member may use, announced so it can pick
 * rather than guess: the group's shared area (for artefacts everyone should
 * see) versus its own private workspace (for personal notes or drafts).
 */
function renderGroupContext(
  session: Session,
  window: number,
  workspaces: { readonly groupWorkspaceDir?: string | undefined; readonly selfWorkspaceDir?: string | undefined } = {},
): string {
  const dirs: string[] = []
  if (workspaces.groupWorkspaceDir !== undefined && workspaces.groupWorkspaceDir !== '') {
    dirs.push(`- 群聊共享工作区：${workspaces.groupWorkspaceDir}（全组成员共用，写在这里的文件其他成员也能看到）`)
  }
  if (workspaces.selfWorkspaceDir !== undefined && workspaces.selfWorkspaceDir !== '') {
    dirs.push(`- 你的私人工作区：${workspaces.selfWorkspaceDir}（只有你能访问，适合放个人草稿与私人记忆）`)
  }
  const workspaceSection = dirs.length === 0
    ? []
    : [
      '',
      '## 可用的工作目录',
      ...dirs,
      '按当前任务自行选择：需要分享给群里其他成员的内容写到共享工作区，属于你自己的内容写到私人工作区。',
      '你的文件工具默认在你的私人工作区；要写入共享工作区请使用上面的绝对路径。',
    ]
  return [
    '以下是群里最近的聊天记录（最后一条是最新消息）：',
    renderTranscript(session, window),
    ...workspaceSection,
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
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Await the nested service's activation so the entry only settles once
  // `chatGroup` is injectable (same rationale as chat-bots).
  await ctx.plugin(ChatGroup, config).await()
}
