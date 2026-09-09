import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  collectAttachmentEvents,
  rememberImageRefs,
  type ChatAttachmentMeta,
} from './attachments.ts'

/**
 * Shared translation of agent session events into the legacy chat-agent
 * event shapes the desktop UI consumes (`message.stream`, `message.created`,
 * `bot.typing`, `agent.tool.*`, `conversation.updated`).
 *
 * Both the private-chat bridge (chat-bots) and the group bridge (chat-group)
 * drive this translator; the transport is one SSE channel
 * (`GET /chatapi/events`) registered by chat-bots.
 */

/** Rich chat row: what `/history` endpoints return and what `message.created` carries. */
export interface ChatMessageRow {
  readonly id: string
  readonly kind: 'user' | 'assistant'
  /** Durable cursor for history paging: the newest session event seq this row aggregates. */
  readonly seq: number
  readonly time: number
  readonly text: string
  readonly senderId: string
  readonly senderName: string
  readonly segments: Array<{ type: 'reasoning' | 'text' | 'tool'; content: string; toolId?: string }>
  readonly toolCalls: Array<{
    id: string
    name: string
    args?: unknown
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    isError?: boolean
  }>
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cachedTokens: number
  readonly durationMs: number
  readonly stopReason: string
  /**
   * Attachments the user sent with this message (images render inline, the
   * rest as cards). Restored from the session log so they survive a reload;
   * absent when the message had none.
   */
  readonly attachments?: readonly ChatAttachmentMeta[]
}

/** Where a translated event goes: one conversation and one speaking bot. */
export interface BridgeTarget {
  readonly conversationId: string
  readonly botId: string
  readonly botName: string
  /** Emit the final `message.created` on turn end (private chats). Group finals arrive via the container log instead. */
  readonly emitFinal: boolean
  /** Full Conversation record for the `conversation.updated` broadcast. */
  readonly conversation?: Record<string, unknown> | undefined
  /**
   * Draft-id namespace prefix (group chats pass the member's bot id).
   *
   * Group member sessions are per-bot, so two members speaking over the same
   * message both produce `m-p0` — their streams would overwrite each other in
   * one shared draft. Prefixing keeps one draft per member. Also see
   * {@link BridgeTarget.omitPromptSeq} for why group frames drop promptSeq.
   */
  readonly draftPrefix?: string | undefined
  /**
   * Suppress `promptSeq` in stream frames (group chats).
   *
   * The front end anchors a draft right after "the Nth user message of the
   * conversation" using promptSeq. In a group, N counts the *member's own*
   * session prompts — unrelated to the group's user-message count — so the
   * anchor never matches and the draft is silently dropped. Without the field
   * the draft renders at the tail, which is correct for groups.
   */
  readonly omitPromptSeq?: boolean | undefined
}

export type Broadcast = (event: string, data: unknown) => void

/** The streaming draft id for the current prompt of one session. */
function draftIdOf(session: Session, target: BridgeTarget): string {
  const seq = promptSeqOf(session)
  return target.draftPrefix === undefined
    ? `m-p${String(seq)}`
    : `${target.draftPrefix}-m-p${String(seq)}`
}

/** The front-end `Message` shape built from one aggregated turn. */
export function toCreatedMessage(row: ChatMessageRow, target: BridgeTarget): Record<string, unknown> {
  return {
    id: row.id,
    conversation_id: target.conversationId,
    sender_type: 'ai_bot',
    sender_id: target.botId,
    sender_name: target.botName,
    content: row.text,
    content_type: 'text',
    is_self: 0,
    created_at: row.time,
    draftId: row.id,
    tool_calls: row.toolCalls,
    segments: row.segments,
    prompt_tokens: row.promptTokens,
    completion_tokens: row.completionTokens,
    cached_tokens: row.cachedTokens,
    duration_ms: row.durationMs,
    stop_reason: row.stopReason,
  }
}

/**
 * Per-session prompt sequence: a user prompt can span several dsh turns
 * (tool-call loops); every stream frame of one run shares the draft id
 * `m-p{N}` so the whole reply lands in ONE chat bubble (legacy semantics).
 *
 * The sequence is derived from the durable session log on every call — a
 * module-level counter would desync after host restart / plugin reload /
 * lazy agent restore (the log already holds N prompts while the counter
 * starts at 0), colliding `m-p1` with a historical row id: the final
 * `message.created` would be deduped by the front end and the bubble vanish.
 */
const promptCountCache = new WeakMap<Session, { length: number; count: number }>()

/**
 * Number of visible user prompts recorded in the session log so far.
 *
 * Exported so `/send` can tell the client which prompt index its message will
 * occupy *before* the driver writes the `user/message` event — the front end
 * needs that index to reserve a loading bubble in the right slot.
 */
export function promptSeqOf(session: Session): number {
  const cached = promptCountCache.get(session)
  let start = 0
  let count = 0
  if (cached !== undefined && cached.length <= session.events.length) {
    start = cached.length
    count = cached.count
  }
  for (let i = start; i < session.events.length; i++) {
    const event = session.events[i]
    if (event === undefined) continue
    if (event.type === 'user/message' && (event.data.source as { kind?: string } | undefined)?.kind === 'user') {
      count += 1
    }
  }
  promptCountCache.set(session, { length: session.events.length, count })
  return count
}

/**
 * Translate one appended session event for one bridge target. `session` is
 * consulted on turn end to aggregate the finished turn (text, tool calls,
 * usage, timing) from the durable log.
 */
export function translateSessionEvent(session: Session, event: SessionEvent, target: BridgeTarget, broadcast: Broadcast): void {
  switch (event.type) {
    case 'user/message': {
      // Sequence is derived from the log (see promptSeqOf) — nothing to bump.
      return
    }
    case 'turn/start': {
      broadcast('bot.typing', {
        conversationId: target.conversationId,
        botId: target.botId,
        botName: target.botName,
        typing: true,
      })
      return
    }
    case 'turn/end': {
      broadcast('bot.typing', {
        conversationId: target.conversationId,
        botId: target.botId,
        botName: target.botName,
        typing: false,
      })

      // Turn failures (LLM 5xx, model_not_found, auth, …) surface as an
      // explicit error message instead of a silent no-reply.
      const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } }).reason
      if (reason?.kind === 'error') {
        broadcast('message.error', {
          conversationId: target.conversationId,
          botId: target.botId,
          botName: target.botName,
          message: reason.error?.message ?? 'LLM 调用失败',
        })
        return
      }

      // One dsh turn = one complete agent run (tool-call loops stay inside
      // the turn); aggregate the prompt run and close the draft. The row id
      // `m-p{N}` MUST match the streaming draft id so the front end can
      // replace the draft with the final message in place.
      const row = aggregatePrompt(session, promptSeqOf(session), target.botId, target.botName)
      broadcast('message.stream', {
        // done 帧的 messageId 必须与流式期间的草稿 id 一致（群聊带前缀），
        // 否则前端删不掉草稿，最终消息与草稿并存
        messageId: draftIdOf(session, target),
        conversationId: target.conversationId,
        botId: target.botId,
        delta: '',
        done: true,
        segments: row.segments,
      })
      if (target.emitFinal && (row.text !== '' || row.toolCalls.length > 0)) {
        broadcast('message.created', toCreatedMessage(row, target))
        if (target.conversation !== undefined) {
          broadcast('conversation.updated', {
            ...target.conversation,
            last_message_preview: row.text.slice(0, 60),
            last_message_at: row.time,
          })
        }
      }
      return
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      const draftId = draftIdOf(session, target)
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        broadcast('message.stream', {
          messageId: draftId,
          conversationId: target.conversationId,
          botId: target.botId,
          delta: chunk.text,
          reasoning: chunk.type === 'reasoning-delta',
          done: false,
          // promptSeq 用于前端把 draft 紧跟到对应的用户消息后（按 N
          // 索引而不是 id 配对，规避前后端 id 命名空间不同步的问题）。
          // 群聊 omit：成员 session 的 N 与群消息序号无关，锚不上反而
          // 导致草稿被丢弃（见 BridgeTarget.omitPromptSeq）
          ...(target.omitPromptSeq === true ? {} : { promptSeq: promptSeqOf(session) }),
        })
      } else if (chunk.type === 'tool-call-delta') {
        // 携带 conversationId/botId 与 chunk.name（首个 delta 通常带工具名），
        // 让前端能在首个文本 delta 之前就创建草稿并识别 write 工具
        broadcast('agent.tool.args', {
          draftId,
          conversationId: target.conversationId,
          botId: target.botId,
          id: chunk.id,
          name: chunk.name ?? '',
          argsStr: chunk.argumentsDelta,
        })
      }
      return
    }
    case 'tool/call': {
      broadcast('agent.tool.start', {
        draftId: draftIdOf(session, target),
        conversationId: target.conversationId,
        botId: target.botId,
        id: event.data.callId,
        name: event.data.name,
        args: safeJson(event.data.arguments),
      })
      return
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      broadcast('agent.tool.end', {
        draftId: draftIdOf(session, target),
        id: block?.toolCallId ?? '',
        result: { content: block?.content ?? [], isError: block?.isError },
        status: 'success',
      })
      return
    }
    default:
      return
  }
}

function eventTurn(event: SessionEvent): number {
  const data = event.data as { turn?: unknown }
  return typeof data.turn === 'number' ? data.turn : -1
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

/**
 * Fold one finished turn of a session log into a single chat row: the text of
 * all its assistant messages, the ordered segment timeline (reasoning / text /
 * tool), accumulated token usage, tool calls, and the turn's wall time.
 */
export function aggregateTurn(session: Session, turn: number, endedAt: number, botId: string, botName: string): ChatMessageRow {
  const segments: ChatMessageRow['segments'] = []
  const toolCalls: ChatMessageRow['toolCalls'] = []
  const byCallId = new Map<string, ChatMessageRow['toolCalls'][number]>()
  let text = ''
  let startedAt = endedAt
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let aborted = false

  for (const event of session.events) {
    if (eventTurn(event) !== turn) continue
    switch (event.type) {
      case 'turn/start': {
        startedAt = event.time
        break
      }
      case 'tool/call': {
        const call = { id: event.data.callId, name: event.data.name, args: safeJson(event.data.arguments) }
        toolCalls.push(call)
        byCallId.set(call.id, call)
        segments.push({ type: 'tool', content: '', toolId: call.id })
        break
      }
      case 'tool/result': {
        const block = event.data.message.content[0]
        const call = block === undefined ? undefined : byCallId.get(block.toolCallId)
        if (call !== undefined && block !== undefined) {
          call.result = { content: block.content, isError: block.isError ?? false }
        }
        break
      }
      case 'assistant/message': {
        if (event.data.interrupted === true) aborted = true
        for (const block of event.data.message.content) {
          if (block.type === 'text') {
            text += block.text
            segments.push({ type: 'text', content: block.text })
          } else if (block.type === 'reasoning') {
            segments.push({ type: 'reasoning', content: block.text })
          }
        }
        const usage = event.data.usage
        if (usage !== undefined) {
          // dsh usage 字段互斥：inputTokens 仅非缓存输入，缓存读/写单独计。
          // 旧 UI 的 prompt_tokens 语义 = 全部输入（含缓存），此处对齐。
          promptTokens += usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          completionTokens += usage.outputTokens
          cachedTokens += usage.cacheReadTokens ?? 0
        }
        break
      }
      default:
        break
    }
  }

  return {
    id: `m-${String(turn)}`,
    kind: 'assistant',
    seq: 0,
    time: endedAt,
    text,
    senderId: botId,
    senderName: botName,
    segments,
    toolCalls,
    promptTokens,
    completionTokens,
    cachedTokens,
    durationMs: Math.max(0, endedAt - startedAt),
    stopReason: aborted ? 'aborted' : '',
  }
}

/**
 * Aggregate the ENTIRE run of the Nth user prompt of a session — all turns it
 * triggered — into one chat row (legacy one-bubble-per-reply semantics).
 */
export function aggregatePrompt(session: Session, promptSeq: number, botId: string, botName: string): ChatMessageRow {
  // Locate the seq boundary of the Nth visible user message, and the next
  // one (if any). Each prompt row must only aggregate its OWN turn —
  // without the upper bound we'd leak every subsequent user message's tool
  // calls into the previous bubble (the "其他对话的工具调用串到当前气泡" bug).
  let seen = 0
  let startSeq = Number.NEGATIVE_INFINITY
  let endSeq = Number.POSITIVE_INFINITY
  for (const event of session.events) {
    if (event.type !== 'user/message') continue
    if ((event.data.source as { kind?: string } | undefined)?.kind !== 'user') continue
    seen += 1
    if (seen === promptSeq) startSeq = event.seq
    else if (seen === promptSeq + 1) { endSeq = event.seq; break }
  }

  let text = ''
  const segments: ChatMessageRow['segments'] = []
  const toolCalls: ChatMessageRow['toolCalls'] = []
  let promptTokens = 0
  let completionTokens = 0
  let cachedTokens = 0
  let durationMs = 0
  let time = 0

  for (const event of session.events) {
    if (event.seq <= startSeq || event.seq >= endSeq || event.type !== 'turn/end') continue
    const row = aggregateTurn(session, eventTurn(event), event.time, botId, botName)
    text += row.text
    segments.push(...row.segments)
    toolCalls.push(...row.toolCalls)
    promptTokens += row.promptTokens
    completionTokens += row.completionTokens
    cachedTokens += row.cachedTokens
    durationMs += row.durationMs
    time = row.time
  }
  return {
    id: `m-p${String(promptSeq)}`,
    kind: 'assistant',
    seq: 0,
    time,
    text,
    senderId: botId,
    senderName: botName,
    segments,
    toolCalls,
    promptTokens,
    completionTokens,
    cachedTokens,
    durationMs,
    stopReason: '',
  }
}

/** The turn number of the last `turn/end` event, or -1 (for group stats). */
export function lastTurnOf(session: Session): number {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event !== undefined && event.type === 'turn/end') return eventTurn(event)
  }
  return -1
}

/** The end-time of the last `turn/end` event, or 0. */
export function lastTurnEndTime(session: Session): number {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event !== undefined && event.type === 'turn/end') return event.time
  }
  return 0
}

/**
 * Aggregate the bot's latest completed run into a rich chat row. Group chat
 * appends this payload into the container event so bubbles carry stats.
 */
export function aggregateLastRun(session: Session, botId: string, botName: string): ChatMessageRow | undefined {
  const turn = lastTurnOf(session)
  if (turn < 0) return undefined
  return aggregateTurn(session, turn, lastTurnEndTime(session), botId, botName)
}

/**
 * Project a private-chat session log into rich chat rows: human prompts only
 * (plugin relays, wake notices and system reminders stay hidden) plus ONE
 * aggregated row per user prompt (its whole multi-turn run).
 */
export function renderPrivateHistory(session: Session, botId: string, botName: string): ChatMessageRow[] {
  const rows: ChatMessageRow[] = []
  const lastTurnEndByPrompt = new Map<number, number>()
  let promptSeq = 0
  // 附件按"下一条 user/message"归属，先整段收集再查表
  const attachmentBySeq = collectAttachmentEvents(session)

  for (const event of session.events) {
    switch (event.type) {
      case 'user/message': {
        if ((event.data.source as { kind?: string } | undefined)?.kind !== 'user') break
        promptSeq += 1
        const text = event.data.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
        // 重新记住图片引用：宿主重启后内存映射是空的，而这里是每次刷新
        // 都会走到的地方，正好用来回填（前端总是先拉历史再画图片）。
        rememberImageRefs(
          event.data.content
            .filter((block): block is Extract<typeof block, { type: 'image' }> => block.type === 'image')
            .map(block => block.attachment),
        )
        const attachments = attachmentBySeq.get(event.seq) ?? []
        // 纯图片消息没有文字，但气泡必须保留——否则只发图片会凭空消失
        if (text === '' && attachments.length === 0) break
        rows.push({
          id: `u-${String(event.seq)}`,
          kind: 'user',
          seq: event.seq,
          time: event.time,
          text,
          senderId: 'me',
          senderName: 'me',
          segments: text === '' ? [] : [{ type: 'text', content: text }],
          toolCalls: [],
          promptTokens: 0,
          completionTokens: 0,
          cachedTokens: 0,
          durationMs: 0,
          stopReason: '',
          ...attachments.length > 0 ? { attachments } : {},
        })
        break
      }
      case 'turn/end': {
        // 一个 dsh turn = 一次完整 run；取该 prompt 的最后一个 turn/end
        // 聚合（若罕见的中间 turn/end 出现，后面的会覆盖——用 Map 去重）
        lastTurnEndByPrompt.set(promptSeq, event.seq)
        break
      }
      default:
        break
    }
  }

  // 第二遍：每个 prompt 的最后 turn/end 落一次聚合行（顺序插入）
  const mergedByPrompt = new Map<number, ChatMessageRow>()
  for (const [seq, endSeq] of lastTurnEndByPrompt) {
    const endEvent = session.events.find(e => e.seq === endSeq)
    if (endEvent === undefined) continue
    const row = aggregatePrompt(session, seq, botId, botName)
    if (row.text === '' && row.toolCalls.length === 0) continue
    // Cursor = the newest event the row spans, so `before` paging is stable.
    mergedByPrompt.set(seq, { ...row, seq: endSeq })
  }

  // 重排：user 行已在 rows 中，按 prompt 序交错插入聚合行
  const finalRows: ChatMessageRow[] = []
  let promptCursor = 0
  for (const row of rows) {
    finalRows.push(row)
    promptCursor += 1
    const merged = mergedByPrompt.get(promptCursor)
    if (merged !== undefined) finalRows.push(merged)
  }
  // 末尾可能还有未配对 user 行的聚合（理论上不存在，防御）
  for (let seq = promptCursor + 1; seq <= lastTurnEndByPrompt.size; seq++) {
    const merged = mergedByPrompt.get(seq)
    if (merged !== undefined) finalRows.push(merged)
  }
  return finalRows
}

/**
 * Cursor-page a chronologically ordered row list (oldest first): take the
 * `limit` rows strictly older than `before`, i.e. the newest page still
 * scrolled above the first visible message. `before` omitted → the newest
 * page. `hasMore` tells the UI whether an even older page exists.
 */
export function pageRows<T extends { readonly seq: number }>(
  rows: readonly T[],
  before: number | undefined,
  limit: number,
): { items: T[]; hasMore: boolean } {
  const eligible = before === undefined ? rows : rows.filter(row => row.seq < before)
  const end = eligible.length
  const start = Math.max(0, end - limit)
  return { items: eligible.slice(start, end), hasMore: start > 0 }
}
