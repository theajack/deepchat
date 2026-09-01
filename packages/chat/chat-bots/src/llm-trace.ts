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
import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

const TRACE_LIMIT = 50

/**
 * Post-normalization facts about one image that reached the model.
 *
 * `bytes`/`width`/`height` describe what the model actually received; the
 * optional `original*` pair is the pre-normalization input, present only when
 * admission scaled the image. The gap between the two is what the debug panel
 * surfaces so a user can see how much their upload was shrunk.
 */
export interface TraceImageInfo {
  readonly attachmentId: string
  readonly name?: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly originalWidth?: number
  readonly originalHeight?: number
}

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
  /** Images carried by this call, in message order. */
  attachments: TraceImageInfo[]
  output: string
  reasoning: string
  toolCalls: { name: string; args?: unknown }[]
  usage: { promptTokens?: number; completionTokens?: number }
  error?: string
}

/**
 * One user-initiated upload, recorded outside the model-call waterfall.
 *
 * Images and documents take different routes — images are admitted into the
 * attachment store and ride along inside the request; documents are written to
 * the bot's workspace and only their path reaches the model. Neither is a model
 * call, so they get their own ring buffer rather than polluting LlmTraceEntry.
 */
export interface UploadTraceEntry {
  readonly id: string
  readonly ts: number
  readonly kind: 'image' | 'file'
  readonly botId?: string
  readonly botName?: string
  readonly name: string
  /** Bytes as originally uploaded, before any normalization. */
  readonly sourceBytes: number
  /** Bytes that actually landed in storage; differs from `sourceBytes` when an image was re-encoded. */
  readonly bytes: number
  /** Images only. */
  readonly mediaType?: string
  /** Images only: dimensions after normalization. */
  readonly width?: number
  readonly height?: number
  /** Images only: dimensions before normalization, when admission scaled it. */
  readonly originalWidth?: number
  readonly originalHeight?: number
  /** Images only: attachment-store id. */
  readonly attachmentId?: string
  /** Files only: workspace-relative path handed to the model. */
  readonly path?: string
  readonly error?: string
}

/** Project an image block's attachment ref onto its trace shape. */
function imageInfo(attachment: ImageBlock['attachment']): TraceImageInfo {
  return {
    attachmentId: String(attachment.attachmentId),
    ...(attachment.name !== undefined ? { name: attachment.name } : {}),
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    ...(attachment.originalDimensions !== undefined ? {
      originalWidth: attachment.originalDimensions.width,
      originalHeight: attachment.originalDimensions.height,
    } : {}),
  }
}

/**
 * Flatten content blocks to display text (images become placeholders), while
 * collecting image facts into `sink` when one is supplied.
 */
function renderBlocks(blocks: readonly ContentBlock[], sink?: TraceImageInfo[]): string {
  return blocks.map((block) => {
    if (block.type === 'text' || block.type === 'reasoning') return block.text
    if (block.type === 'image') {
      sink?.push(imageInfo(block.attachment))
      return '[图片]'
    }
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
  private uploads: UploadTraceEntry[] = []

  constructor(ctx: Context, resolveBot: TraceBotResolver) {
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
      this.traceOne(options, next, resolveBot))
  }

  /** Newest-first snapshot for the debug window. */
  list(): LlmTraceEntry[] {
    return this.entries
  }

  /** Newest-first upload log for the debug window. */
  listUploads(): UploadTraceEntry[] {
    return this.uploads
  }

  /**
   * Record a user-initiated upload. Callers outside the model waterfall
   * (`/send` image admission, the `upload-file` action) use this to make an
   * otherwise invisible step inspectable.
   */
  recordUpload(entry: Omit<UploadTraceEntry, 'id' | 'ts'>): void {
    this.uploads.unshift({ id: randomUUID(), ts: Date.now(), ...entry })
    if (this.uploads.length > TRACE_LIMIT) this.uploads.length = TRACE_LIMIT
  }

  clear(): void {
    this.entries = []
    this.uploads = []
  }

  private async *traceOne(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
    resolveBot: TraceBotResolver,
  ): AsyncIterable<StreamChunk> {
    const sessionId = options.sessionId
    const bot = resolveBot(sessionId)
    // Images are flattened to placeholders in the rendered text, so collect
    // their facts separately to keep them inspectable in the debug panel.
    const attachments: TraceImageInfo[] = []
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
      input: options.messages.map(message => ({
        role: message.role,
        content: renderBlocks(message.content, attachments),
      })),
      attachments,
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
