/**
 * LLM call trace recorder for the debug panel's「对话信息」window.
 *
 * Taps the dsh `llm/stream` waterfall (fired around every streaming model
 * call, including retry/routing) and accumulates one entry per request:
 * system prompt, input messages, streamed output/reasoning, tool calls,
 * token usage and errors. Entries live in an in-memory ring buffer exposed
 * via `/chatapi/llm-trace` and are lost on host restart — mirrors the legacy
 * chat-agent `llm.trace.list` semantics.
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const TRACE_LIMIT = 50

/** One recorded model call (shape-compatible with the legacy UI LlmTraceEntry). */
export interface LlmTraceEntry {
  readonly id: string
  readonly ts: number
  readonly provider: string
  readonly model: string
  readonly kind: 'chat' | 'stream'
  readonly conversationId?: string
  readonly botId?: string
  readonly botName?: string
  readonly purpose?: string
  system: string
  input: { role: string; content: string }[]
  output: string
  reasoning: string
  toolCalls: { name: string; args?: unknown }[]
  usage: { promptTokens?: number; completionTokens?: number }
  error?: string
}

/** Flatten content blocks to display text (images become placeholders). */
function renderBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'image') return '[图片]'
    if (block.type === 'tool-call') return `[工具调用 ${block.name}]`
    return `[${block.type}]`
  }).join('\n')
}

/** Map dsh's mutually-exclusive usage fields to the legacy sum semantics. */
function toLegacyUsage(usage: TokenUsage): { promptTokens?: number; completionTokens?: number } {
  return {
    promptTokens: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    completionTokens: usage.outputTokens,
  }
}

/** Resolves the chat bot behind a dsh session id (bot sessions are dedicated). */
export type TraceBotResolver = (sessionId: SessionId | undefined) => { botId: string; botName: string } | undefined

export class LlmTraceRecorder {
  private entries: LlmTraceEntry[] = []

  constructor(ctx: Context, resolveBot: TraceBotResolver) {
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
      this.traceOne(options, next, resolveBot))
  }

  /** Newest-first snapshot for the debug window. */
  list(): LlmTraceEntry[] {
    return this.entries
  }

  clear(): void {
    this.entries = []
  }

  private async *traceOne(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
    resolveBot: TraceBotResolver,
  ): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    const bot = resolveBot(sessionId)
    const entry: LlmTraceEntry = {
      id: randomUUID(),
      ts: Date.now(),
      provider: options.provider,
      model: options.model,
      kind: 'stream',
      ...(sessionId !== undefined ? { conversationId: sessionId } : {}),
      ...(bot !== undefined ? { botId: bot.botId, botName: bot.botName } : {}),
      ...(options.purpose !== undefined ? { purpose: options.purpose } : {}),
      system: options.system ?? '',
      input: options.messages.map(message => ({ role: message.role, content: renderBlocks(message.content) })),
      output: '',
      reasoning: '',
      toolCalls: [],
      usage: {},
    }
    this.entries.unshift(entry)
    if (this.entries.length > TRACE_LIMIT) this.entries.length = TRACE_LIMIT

    try {
      for await (const chunk of next()) {
        if (chunk.type === 'text-delta') {
          entry.output += chunk.text
        } else if (chunk.type === 'reasoning-delta') {
          entry.reasoning += chunk.text
        } else if (chunk.type === 'usage') {
          entry.usage = toLegacyUsage(chunk.usage)
        } else if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const block = chunk.block as { name: string; input?: unknown }
          entry.toolCalls.push({ name: block.name, ...(block.input !== undefined ? { args: block.input } : {}) })
        }
        yield chunk
      }
    } catch (error: unknown) {
      entry.error = String(error)
      throw error
    }
  }
}
