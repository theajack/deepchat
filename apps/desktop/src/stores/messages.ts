import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'
import { transport } from '../services/ipc'
import type { Conversation, Message, MessageAttachment, StreamFrame, TypingFrame } from '../types'
import { useConversationsStore } from './conversations'
import { openUrl } from '../utils/browser'

export interface StreamSegment {
  type: 'reasoning' | 'text' | 'tool'
  content: string
  /** 思维链耗时（毫秒），仅 reasoning 段有意义 */
  durationMs?: number
  /** tool 段：关联的工具调用 ID */
  toolId?: string
}

export interface StreamDraft {
  draftId: string
  conversationId: string
  botId: string
  /**
   * 触发该回复的用户消息本地 id（send 时分配）。多个用户消息连续发送时，
   * 各自触发的草稿会消费各自挂起的锚点——渲染时把草稿排在它指向的用户
   * 消息之后。
   */
  anchorMsgId?: string
  content: string
  /** 草稿创建时间（用于按 createdAt 排序，插入到 byConv 中正确的位置） */
  createdAt: number
  /** 有序段落列表（思维链与正文交替） */
  segments: StreamSegment[]
}

export interface ToolCall {
  id: string
  name: string
  args?: unknown
  /** 模型流式输出参数时的累积 JSON 字符串（write 工具实时展示用） */
  argsStr?: string
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown }
  status: 'running' | 'success' | 'error'
  /** 工具执行耗时（毫秒），执行结束后才有值 */
  durationMs?: number
}

/** 返回剔除指定 key 后的新对象（避免动态 delete） */
function omitKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key))
}

/** 历史消息分页大小（向上翻页每次加载的条数） */
const PAGE_SIZE = 50

/** 消息模块：历史消息 + 流式草稿 + typing 状态 + CLI 事件桥接 */
export const useMessagesStore = defineStore('messages', () => {
  const byConv = ref<Record<string, Message[]>>({})
  /** 每个会话是否还有更早的历史（false = 已到顶） */
  const hasMoreByConv = ref<Record<string, boolean>>({})
  /** 是否正在向上翻页（并发防护） */
  const loadingMore = ref(false)
  /** 群聊正在决策由谁发言（conversationId → 是否决策中） */
  const scheduling = ref<Record<string, boolean>>({})
  /** 定位请求：搜索弹窗点击「定位」后，MessageList 滚动到该消息；nonce 用于重复定位同一条消息 */
  const locate = ref<{ conversationId: string; messageId: string; nonce: number } | null>(null)

  function requestLocate(conversationId: string, messageId: string) {
    locate.value = { conversationId, messageId, nonce: Date.now() }
  }
  /** 进行中的流式回复，key = draftId */
  const streams = ref<Record<string, StreamDraft>>({})
  /** Agent 运行时的工具调用，key = draftId 或 messageId */
  const toolCalls = ref<Record<string, ToolCall[]>>({})
  /** 历史消息的权威 segments（持久化的），key = messageId 或 draftId */
  const segmentsCache = ref<Record<string, StreamSegment[]>>({})
  /** 正在输入的 bot，key = `${convId}:${botId}`，value = botName */
  const typing = ref<Record<string, string>>({})
  /** reasoning 计时：key = draftId，value = 开始时间戳 */
  const reasoningStartAt = new Map<string, number>()
  /** tool 执行计时：key = toolCallId，value = 开始时间戳 */
  const toolStartAt = new Map<string, number>()
  /** openUrl 工具参数：key = toolCallId，value = 待打开的 url 参数 */
  const openUrlArgs = new Map<string, string>()

  // ── 工具参数打字机释放 ──
  // 部分中转服务器把整个 tool_calls arguments 打包在一个大 chunk 里（文本
  // delta 是细粒度的，工具参数不是），用户会盯着空卡片等十几秒。大块到达
  // 后按帧渐进渲染，视觉上与真流式一致；真实小 delta 直接透传。
  const TYPER_THRESHOLD = 120
  interface ToolTyper { buffer: string; timer: number | undefined }
  const toolTypers = new Map<string, ToolTyper>()

  /** 释放速率：~2.5 秒内放完（每 16ms 一帧），最慢 24 字/帧 */
  function typerTick(typer: ToolTyper, apply: (released: string) => void): void {
    const release = Math.max(24, Math.ceil(typer.buffer.length / 150))
    const released = typer.buffer.slice(0, release)
    typer.buffer = typer.buffer.slice(release)
    apply(released)
    if (typer.buffer.length === 0) {
      if (typer.timer !== undefined) window.clearInterval(typer.timer)
      typer.timer = undefined
    }
  }

  /** 大块 argsStr 进缓冲，启动打字机；返回值表示是否进入渐进模式 */
  function feedTyper(toolId: string, chunk: string, apply: (released: string) => void): boolean {
    if (chunk.length <= TYPER_THRESHOLD) {
      if (chunk.length > 0) apply(chunk)
      return false
    }
    let typer = toolTypers.get(toolId)
    if (!typer) {
      typer = { buffer: '', timer: undefined }
      toolTypers.set(toolId, typer)
    }
    typer.buffer += chunk
    if (typer.timer === undefined) {
      const bound = typer
      bound.timer = window.setInterval(() => typerTick(bound, apply), 16)
    }
    return true
  }

  /** 工具开始执行/结束时立即放完剩余缓冲（保证 args 完整） */
  function flushTyper(toolId: string, apply: (released: string) => void): void {
    const typer = toolTypers.get(toolId)
    if (!typer) return
    if (typer.timer !== undefined) window.clearInterval(typer.timer)
    toolTypers.delete(toolId)
    if (typer.buffer.length > 0) apply(typer.buffer)
  }

  /** 清空所有打字机（会话切换/清空时） */
  function disposeTypers(): void {
    for (const typer of toolTypers.values()) {
      if (typer.timer !== undefined) window.clearInterval(typer.timer)
    }
    toolTypers.clear()
  }

  let eventsBound = false

  /** 首页只拉最近一页（默认 50 条），更早的由 loadMore 向上翻页补齐 */
  async function load(conversationId: string) {
    const page = await chatApi.listMessages(conversationId, undefined, PAGE_SIZE)
    byConv.value = { ...byConv.value, [conversationId]: page.items }
    hasMoreByConv.value = { ...hasMoreByConv.value, [conversationId]: page.hasMore }
    loadingMore.value = false
    // 恢复历史消息的工具调用展示（刷新后不丢失）
    cacheHistoryExtras(page.items)
  }

  /**
   * 向上翻页：加载最早一条之前的 PAGE_SIZE 条并前置到列表。
   * 返回新加载的条数（0 表示已到顶），供 UI 恢复滚动位置。
   */
  async function loadMore(conversationId: string): Promise<number> {
    if (loadingMore.value) return 0
    if (hasMoreByConv.value[conversationId] !== true) return 0
    const list = byConv.value[conversationId] ?? []
    const oldest = list[0]
    if (oldest === undefined || oldest.seq === undefined) return 0
    loadingMore.value = true
    try {
      const page = await chatApi.listMessages(conversationId, oldest.seq, PAGE_SIZE)
      if (page.items.length === 0) {
        hasMoreByConv.value = { ...hasMoreByConv.value, [conversationId]: false }
        return 0
      }
      // 防御：并发或重复事件导致的重叠行按 id 去重
      const known = new Set(list.map(m => m.id))
      const older = page.items.filter(m => !known.has(m.id))
      byConv.value = { ...byConv.value, [conversationId]: [...older, ...list] }
      hasMoreByConv.value = { ...hasMoreByConv.value, [conversationId]: page.hasMore }
      cacheHistoryExtras(older)
      return older.length
    } finally {
      loadingMore.value = false
    }
  }

  /** 缓存历史消息的工具调用与 segments（刷新后不丢失） */
  function cacheHistoryExtras(list: Message[]): void {
    const tc = { ...toolCalls.value }
    const sc = { ...segmentsCache.value }
    for (const m of list) {
      if (m.tool_calls && m.tool_calls.length > 0) {
        tc[m.id] = m.tool_calls.map(c => ({
          id: c.id,
          name: c.name,
          args: c.args,
          result: c.result,
          status: c.isError ? 'error' : 'success',
        }))
      }
      // 缓存历史消息的 segments（权威来源）
      if (m.segments) {
        sc[m.id] = m.segments
      }
    }
    toolCalls.value = tc
    segmentsCache.value = sc
  }

  async function send(
    conversationId: string,
    content: string,
    images?: Array<{ mediaType: string; data: string; name?: string; size?: number }>,
    attachments?: MessageAttachment[],
  ) {
    // 本地 id：占位 + 锚点（stream draft 据此把回复插在用户消息之后）
    const localId = crypto.randomUUID()
    pendingAnchors.push({ localMsgId: localId, conversationId })
    // 先把 placeholder 推进 byConv —— 立即让输入框后的 UI 看到这条消息，
    // 同时为后面的回复提供锚定位置。等后端确认后用真实 id 替换。
    append({
      id: localId,
      conversation_id: conversationId,
      sender_type: 'user',
      sender_id: 'me',
      sender_name: 'me',
      content,
      content_type: 'text',
      is_self: 1,
      created_at: Date.now(),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
    })
    const real = await chatApi.sendMessage(conversationId, content, images, attachments)
    // 真实 msg 到达：用真实 id 替换本地占位（content 已带附件，省去重发）
    if (real.id !== localId) {
      const list = byConv.value[conversationId] ?? []
      const idx = list.findIndex(m => m.id === localId)
      if (idx !== -1) {
        const next = list.slice()
        next[idx] = { ...next[idx], id: real.id }
        byConv.value = { ...byConv.value, [conversationId]: next }
      }
      // 锚点也跟着重命名（draftId/anchorMsgId 之间的对应不变）
      for (let i = 0; i < pendingAnchors.length; i++) {
        const a = pendingAnchors[i]
        if (a === undefined) continue
        if (a.localMsgId === localId) {
          pendingAnchors.splice(i, 1, { ...a, localMsgId: real.id })
          break
        }
      }
    }
  }

  /** 终止正在生成的 AI 回复（botId 省略则终止该会话所有 bot） */
  async function stopGeneration(conversationId: string, botId?: string) {
    await chatApi.stopMessage(conversationId, botId)
  }

  function append(msg: Message) {
    if (msg.sender_type === 'ai_bot') msg.content = msg.content.trim()
    const list = byConv.value[msg.conversation_id] ?? []
    if (list.some(m => m.id === msg.id)) return
    byConv.value = { ...byConv.value, [msg.conversation_id]: [...list, msg] }
  }

  /**
 * FIFO 队列：每个挂起项是 `{ localMsgId, conversationId }`。
 *
 * send() 推一个进来；`message.stream` 帧首次为该 conversationId 创建 draft 时，
 * 按 FIFO 取一个挂起，把对应的本地 id 写进 draft.anchorMsgId。
 *
 * 私聊场景（一个 bot）下这是精确配对；群聊场景下多个 bot 的回复也会按入队
 * 顺序认领各自锚点，因为同一时刻不会出现多个 draft 同时被首次创建（驱动串行）。
 */
  const pendingAnchors: Array<{ localMsgId: string; conversationId: string }> = []

  /**
 * Claim the next pending anchor for `conversationId`, if any. Called when a
 * new stream draft is created.
 */
  function takeAnchor(conversationId: string): string | undefined {
    for (let i = 0; i < pendingAnchors.length; i++) {
      const a = pendingAnchors[i]
      if (a === undefined) continue
      if (a.conversationId === conversationId) {
        pendingAnchors.splice(i, 1)
        return a.localMsgId
      }
    }
    return undefined
  }

  /** 工具事件早于首个文本 delta 到达时创建空草稿（content 为空、segments 为空），
   *  让工具卡片在模型生成工具参数期间即可见（如 write 大文件流式预览） */
  function ensureStreamDraft(draftId: string, conversationId?: string, botId?: string) {
    if (streams.value[draftId]) return
    if (!conversationId || !botId) return
    const anchorMsgId = takeAnchor(conversationId)
    streams.value = {
      ...streams.value,
      [draftId]: {
        draftId,
        conversationId,
        botId,
        // 用户消息 id（send 时本地分配）：草稿据此插入到 byConv 中
        // 该用户消息之后。多个用户消息连续发送时，每个草稿消费一个挂起，
        // 保证回复分别落在各自的用户消息下方。
        anchorMsgId,
        content: '',
        // 用模型驱动事件的当前时间作为草稿创建时间（同一 stream 第一次
        // 创建后再不会变），渲染时按此把草稿插入 byConv 中正确的位置
        createdAt: Date.now(),
        segments: [],
      },
    }
  }

  /** 将 tool 段插入流式草稿的时间线（若已存在则跳过），保证工具调用与文本按时间顺序排列 */
  function upsertToolSegment(draftId: string, toolId: string) {
    const draft = streams.value[draftId]
    if (!draft) return
    if (draft.segments.some(s => s.type === 'tool' && s.toolId === toolId)) return
    streams.value = {
      ...streams.value,
      [draftId]: {
        ...draft,
        segments: [...draft.segments, { type: 'tool', content: '', toolId }],
      },
    }
  }

  /** 订阅 CLI 推送事件（只绑定一次） */
  function bindEvents() {
    if (eventsBound) return
    eventsBound = true
    transport.onEvent((frame) => {
      console.log('[AGENT-DBG] messages.onEvent', frame.event)
      switch (frame.event) {
        case 'message.cleared': {
          // 服务端会话已清空（新 session）：清除该会话全部本地状态，
          // 包括消息、流式草稿、工具调用与 typing（旧 run 的残留事件一律丢弃）
          const c = frame.data as { conversationId: string }
          byConv.value = { ...byConv.value, [c.conversationId]: [] }
          hasMoreByConv.value = { ...hasMoreByConv.value, [c.conversationId]: false }
          cleanupDrafts(c.conversationId)
          typing.value = Object.fromEntries(
            Object.entries(typing.value).filter(([key]) => !key.startsWith(`${c.conversationId}:`)))
          scheduling.value = omitKey(scheduling.value, c.conversationId)
          // 新 session 的 draftId（m-p1…）会与旧 run 碰撞，直接整体清空；
          // 其他会话的记录在切换/load 时会按历史重建
          toolCalls.value = {}
          segmentsCache.value = {}
          break
        }
        case 'message.error': {
          // turn 以 error 结束（LLM 5xx / model_not_found / 凭据失效等）：
          // 以一条错误消息呈现，避免静默无回复
          const e = frame.data as { conversationId: string; botId: string; botName?: string; message: string }
          append({
            id: `err-${String(Date.now())}`,
            conversation_id: e.conversationId,
            sender_type: 'ai_bot',
            sender_id: e.botId,
            sender_name: e.botName ?? '',
            content: `⚠️ ${e.message}`,
            content_type: 'text',
            is_self: 0,
            created_at: Date.now(),
          } as Message)
          break        }
        case 'message.stream': {
          const f = frame.data as StreamFrame & { reasoning?: boolean; segments?: StreamSegment[] }
          if (f.done) {
            // 如果 done 事件带权威 segments（含 durationMs），先缓存它们
            if (f.segments) {
              segmentsCache.value = { ...segmentsCache.value }
              segmentsCache.value[f.messageId] = f.segments
            }
            reasoningStartAt.delete(f.messageId)
            streams.value = omitKey(streams.value, f.messageId)
            // 防御：stream 结束时同步清除该 bot 的 typing 状态，
            // 避免 stream 已删但 typing 仍 true 导致空 loading 气泡闪现
            const typingKey = `${f.conversationId}:${f.botId}`
            if (typing.value[typingKey]) {
              typing.value = omitKey(typing.value, typingKey)
            }
          } else {
            const prev = streams.value[f.messageId]
            // 草稿重建（agent loop 后续 turn 的流式帧）：移除已落定的同 id
            // 旧消息，让草稿接管渲染，避免重复气泡与 created 去重吞消息
            if (!prev) {
              const list = byConv.value[f.conversationId] ?? []
              if (list.some(m => m.id === f.messageId)) {
                byConv.value = {
                  ...byConv.value,
                  [f.conversationId]: list.filter(m => m.id !== f.messageId),
                }
              }
            }
            const segType: StreamSegment['type'] = f.reasoning ? 'reasoning' : 'text'
            const prevSegs = prev?.segments ?? []
            const lastSeg = prevSegs.length > 0 ? prevSegs[prevSegs.length - 1] : null

            // reasoning 计时：首次收到 reasoning delta 时记录开始时间；
            // 收到 text delta（reasoning 结束）时给最后一个 reasoning 段补上 durationMs
            if (f.reasoning && !reasoningStartAt.has(f.messageId)) {
              reasoningStartAt.set(f.messageId, Date.now())
            }
            if (!f.reasoning && reasoningStartAt.has(f.messageId)) {
              // reasoning 刚结束，给最后一个 reasoning segment 补 durationMs
              for (let si = prevSegs.length - 1; si >= 0; si--) {
                if (prevSegs[si].type === 'reasoning' && !prevSegs[si].durationMs) {
                  prevSegs[si] = { ...prevSegs[si], durationMs: Date.now() - (reasoningStartAt.get(f.messageId) ?? Date.now()) }
                  break
                }
              }
              reasoningStartAt.delete(f.messageId)
            }

            const segments =
              lastSeg && lastSeg.type === segType
                ? [...prevSegs.slice(0, -1), { type: segType, content: lastSeg.content + f.delta, durationMs: lastSeg.durationMs }]
                : [...prevSegs, { type: segType, content: f.delta }]
            const content = f.reasoning
              ? prev?.content ?? ''
              : (prev?.content ?? '') + f.delta
            // 首次创建草稿：让 ensureStreamDraft 负责挂起挂载（pendingAnchors
            // FIFO 消费），确保草稿锚定到正确的用户消息。
            ensureStreamDraft(f.messageId, f.conversationId, f.botId)
            streams.value = {
              ...streams.value,
              [f.messageId]: {
                ...(streams.value[f.messageId] ?? { draftId: f.messageId, conversationId: f.conversationId, botId: f.botId }),
                content,
                segments,
              },
            }
          }
          break
        }
        case 'agent.tool.args': {
          // 模型流式输出工具参数（如 write 工具的 content），先于 tool.start 到达。
          // 工具调用可能早于首个文本 delta（模型先写代码再说话），此时草稿
          // 尚未创建 —— 先按事件携带的会话信息创建空草稿，保证工具卡片立即可见
          const d = frame.data as { draftId: string; conversationId?: string; botId?: string; id: string; name: string; argsStr: string }
          if (!d.draftId) break
          ensureStreamDraft(d.draftId, d.conversationId, d.botId)
          const arr = toolCalls.value[d.draftId] ?? []
          let t = arr.find(x => x.id === d.id)
          if (!t) {
            t = { id: d.id, name: d.name, status: 'running', argsStr: '' }
            arr.push(t)
          }
          // 首个 delta 携带工具名，后续为空 —— 仅回填非空值
          if (d.name && !t.name) t.name = d.name
          // 大块 delta 走打字机渐进释放；小 delta 直接透传
          const append = (s: string): void => {
            t.argsStr += s
            toolCalls.value = { ...toolCalls.value, [d.draftId]: [...arr] }
          }
          feedTyper(d.id, d.argsStr, append)
          toolCalls.value = { ...toolCalls.value, [d.draftId]: [...arr] }
          upsertToolSegment(d.draftId, d.id)
          break
        }
        case 'agent.tool.start': {
          const d = frame.data as { draftId: string; conversationId?: string; botId?: string; id: string; name: string; args?: unknown }
          if (!d.draftId) break
          ensureStreamDraft(d.draftId, d.conversationId, d.botId)
          const arr = toolCalls.value[d.draftId] ?? []
          const t = arr.find(x => x.id === d.id)
          if (t) {
            // 该调用可能已由更早的 tool.args 增量帧创建（那时 name 为空），
            // 此处是权威来源：回填 name、args 与 status（tool.args 创建时未设 status，
            // 这里若不补 running 会导致 timeline.isActive=false → 卡片折叠）
            if (d.name) t.name = d.name
            if (d.args !== undefined) t.args = d.args
            if (!t.status) t.status = 'running'
          } else {
            arr.push({ id: d.id, name: d.name, args: d.args, status: 'running' })
          }
          // 工具开始执行：args 已完整，停掉打字机并放完剩余缓冲
          flushTyper(d.id, () => {})
          toolCalls.value = { ...toolCalls.value, [d.draftId]: arr }
          upsertToolSegment(d.draftId, d.id)
          // 记录工具开始执行时间
          toolStartAt.set(d.id, Date.now())
          // openUrl 工具：记录参数，tool.end 成功后按 default_browser 设置打开
          if (d.name === 'openUrl') {
            const url = (d.args as { url?: unknown } | undefined)?.url
            if (typeof url === 'string' && url.trim() !== '') openUrlArgs.set(d.id, url)
          }
          break
        }
        case 'agent.tool.update': {
          const d = frame.data as { draftId: string; id: string; result?: unknown; status?: ToolCall['status'] }
          const arr = toolCalls.value[d.draftId]
          const t = arr?.find(x => x.id === d.id)
          if (t) {
            if (d.result !== undefined) t.result = d.result as ToolCall['result']
            if (d.status) t.status = d.status
            toolCalls.value = { ...toolCalls.value, [d.draftId]: [...arr] }
          }
          break
        }
        case 'agent.tool.end': {
          const d = frame.data as { draftId: string; id: string; name?: string; result?: ToolCall['result']; status?: ToolCall['status'] }
          const arr = toolCalls.value[d.draftId]
          const t = arr?.find(x => x.id === d.id)
          // 工具结束：停掉打字机（args 权威值已由 tool.start 设置）
          flushTyper(d.id, () => {})
          if (t) {
            if (d.result !== undefined) t.result = d.result
            t.status = d.status ?? 'success'
            // 计算工具执行耗时
            const start = toolStartAt.get(d.id)
            if (start) {
              t.durationMs = Date.now() - start
              toolStartAt.delete(d.id)
            }
            toolCalls.value = { ...toolCalls.value, [d.draftId]: [...arr] }
          }
          // openUrl 工具：执行成功后按 default_browser 设置打开
          // （builtin → 应用内浏览器窗口；system → 经后端系统命令打开）
          if ((d.name ?? t?.name) === 'openUrl') {
            const url = openUrlArgs.get(d.id)
            openUrlArgs.delete(d.id)
            const failed = (d.result as { isError?: boolean } | undefined)?.isError === true
            if (url !== undefined && !failed) void openUrl(url)
          }
          break
        }
        case 'message.created': {
          const msg = frame.data as Message
          append(msg)
          // 清理同 conversationId + botId 的流式草稿（draftId 与 msg.id 不同）
          // 同时清理 typing 状态，避免空 loading 气泡残留
          const staleDrafts = Object.entries(streams.value)
            .filter(([, d]) => d.conversationId === msg.conversation_id && d.botId === msg.sender_id)
          if (staleDrafts.length > 0) {
            const staleIds = new Set(staleDrafts.map(([did]) => did))
            streams.value = Object.fromEntries(
              Object.entries(streams.value).filter(([did]) => !staleIds.has(did)))
          }
          // typing 也清除（done 事件可能丢失）
          const typingKey = `${msg.conversation_id}:${msg.sender_id}`
          if (typing.value[typingKey]) {
            typing.value = omitKey(typing.value, typingKey)
          }
          // 精确迁移：只把属于该消息 draftId 的 toolCalls 迁过去
          // 避免其他 draftId 残留的工具调用被错误迁到本消息（修复截图 bug）
          if (msg.draftId && toolCalls.value[msg.draftId]) {
            // 消息落定：停掉该草稿所有工具的打字机（args 已由 tool.start 补全）
            for (const tc of toolCalls.value[msg.draftId]) flushTyper(tc.id, () => {})
            toolCalls.value = {
              ...omitKey(toolCalls.value, msg.draftId),
              [msg.id]: toolCalls.value[msg.draftId],
            }
          }
          // 群聊消息（无草稿）：直接用事件携带的 tool_calls 落表
          else if (msg.tool_calls && msg.tool_calls.length > 0) {
            toolCalls.value = {
              ...toolCalls.value,
              [msg.id]: msg.tool_calls.map(tc => ({
                id: tc.id,
                name: tc.name,
                args: tc.args,
                status: 'success',
                result: tc.result,
              })),
            }
          }
          // 缓存权威 segments：历史消息加载 / 刷新后用此渲染 timeline
          if (msg.segments) {
            segmentsCache.value[msg.id] = msg.segments
          }
          break
        }
        case 'group.scheduling': {
          // 群聊决策中：显示"成员正在思考"，决策结束立即关闭
          const f = frame.data as { conversationId: string; active: boolean }
          if (f.active) {
            scheduling.value = { ...scheduling.value, [f.conversationId]: true }
          } else {
            scheduling.value = omitKey(scheduling.value, f.conversationId)
          }
          break
        }
        case 'bot.typing': {
          const f = frame.data as TypingFrame
          const key = `${f.conversationId}:${f.botId}`
          if (f.typing) {
            typing.value = { ...typing.value, [key]: f.botName }
          } else {
            typing.value = omitKey(typing.value, key)
          }
          break
        }
        case 'conversation.updated':
          useConversationsStore().applyUpdate(frame.data as Conversation)
          break
      }
    })
  }

  function getToolCalls(draftId: string): ToolCall[] {
    return toolCalls.value[draftId] ?? []
  }

  /** 获取消息的权威 segments（流式时用 stream 草稿的，完成后用持久化的） */
  function getSegments(messageId: string, draftId?: string): StreamSegment[] {
    // 流式中：从 stream 草稿取
    if (draftId && streams.value[draftId]) {
      return streams.value[draftId].segments
    }
    // 完成后：从持久化缓存取（messageId 或 draftId 均可）
    return segmentsCache.value[messageId] ?? (draftId ? segmentsCache.value[draftId] ?? [] : [])
  }

  /** 清理指定会话的所有脏草稿与 typing（兜底：done 事件丢失时使用） */
  function cleanupDrafts(conversationId: string) {
    disposeTypers()
    if (Object.values(streams.value).some(d => d.conversationId === conversationId)) {
      streams.value = Object.fromEntries(
        Object.entries(streams.value).filter(([, d]) => d.conversationId !== conversationId))
    }

    typing.value = Object.fromEntries(
      Object.entries(typing.value).filter(([k]) => !k.startsWith(`${conversationId}:`)))
  }

  /** 清空指定会话的本地消息列表及流式草稿 */
  function clearLocal(conversationId: string) {
    byConv.value = { ...byConv.value, [conversationId]: [] }
    hasMoreByConv.value = { ...hasMoreByConv.value, [conversationId]: false }
    cleanupDrafts(conversationId)
    // 清理该会话流式草稿对应的工具调用记录
    const next = { ...byConv.value }
    const validIds = new Set(next[conversationId]?.map(m => m.id) ?? [])
    // 已无对应消息或草稿的 toolCall 一并清除
    toolCalls.value = Object.fromEntries(
      Object.entries(toolCalls.value)
        .filter(([key]) => validIds.has(key) || streams.value[key] !== undefined))
  }

  return {
    byConv, streams, typing, toolCalls, getToolCalls, getSegments,
    load, loadMore, send, stopGeneration, bindEvents, cleanupDrafts, clearLocal,
    locate, requestLocate, hasMoreByConv, loadingMore, scheduling,
  }
})
