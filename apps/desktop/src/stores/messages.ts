import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'
import { transport } from '../services/ipc'
import type { Conversation, Message, StreamFrame, TypingFrame } from '../types'
import { useConversationsStore } from './conversations'
import { openUrlBuiltin } from '../utils/browser'

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
  content: string
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

/** 消息模块：历史消息 + 流式草稿 + typing 状态 + CLI 事件桥接 */
export const useMessagesStore = defineStore('messages', () => {
  const byConv = ref<Record<string, Message[]>>({})
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

  let eventsBound = false

  async function load(conversationId: string) {
    // 默认只加载最近 100 条，保证性能
    const list = await chatApi.listMessages(conversationId, undefined, 100)
    byConv.value = { ...byConv.value, [conversationId]: list }
    // 恢复历史消息的工具调用展示（刷新后不丢失）
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

  async function send(conversationId: string, content: string) {
    const msg = await chatApi.sendMessage(conversationId, content)
    append(msg)
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
            streams.value = {
              ...streams.value,
              [f.messageId]: {
                draftId: f.messageId,
                conversationId: f.conversationId,
                botId: f.botId,
                content,
                segments,
              },
            }
          }
          break
        }
        case 'agent.tool.args': {
          // 模型流式输出工具参数（如 write 工具的 content），先于 tool.start 到达
          const d = frame.data as { draftId: string; id: string; name: string; argsStr: string }
          if (!d.draftId) break
          const arr = toolCalls.value[d.draftId] ?? []
          let t = arr.find(x => x.id === d.id)
          if (!t) {
            t = { id: d.id, name: d.name, status: 'running', argsStr: '' }
            arr.push(t)
          }
          t.argsStr = d.argsStr
          toolCalls.value = { ...toolCalls.value, [d.draftId]: [...arr] }
          upsertToolSegment(d.draftId, d.id)
          break
        }
        case 'agent.tool.start': {
          const d = frame.data as { draftId: string; id: string; name: string; args?: unknown }
          if (!d.draftId) break
          const arr = toolCalls.value[d.draftId] ?? []
          const t = arr.find(x => x.id === d.id)
          if (t) {
            if (d.args !== undefined) t.args = d.args
          } else {
            arr.push({ id: d.id, name: d.name, args: d.args, status: 'running' })
          }
          toolCalls.value = { ...toolCalls.value, [d.draftId]: arr }
          upsertToolSegment(d.draftId, d.id)
          // 记录工具开始执行时间
          toolStartAt.set(d.id, Date.now())
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
          // openUrl 工具内置浏览器模式：打开独立浏览器窗口（异步，不阻塞事件处理）
          if (d.name === 'openUrl' && d.result) {
            const details = (d.result as { details?: { action?: string; url?: string } }).details
            if (details?.action === 'open_builtin_browser' && details.url) {
              void openUrlBuiltin(details.url)
            }
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
            toolCalls.value = {
              ...omitKey(toolCalls.value, msg.draftId),
              [msg.id]: toolCalls.value[msg.draftId],
            }
          }
          // 缓存权威 segments：历史消息加载 / 刷新后用此渲染 timeline
          if (msg.segments) {
            segmentsCache.value[msg.id] = msg.segments
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
    load, send, stopGeneration, bindEvents, cleanupDrafts, clearLocal,
  }
})
