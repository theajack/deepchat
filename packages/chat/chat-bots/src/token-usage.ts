/**
 * Token usage accounting, backing the settings「Token 消耗」window.
 *
 * Taps the same dsh `llm/stream` waterfall as {@link LlmTraceRecorder} but
 * keeps a completely separate, durable record: one row per
 * (model, local calendar day). Being durable is what makes the 7-day trend
 * possible at all — the trace recorder is an in-memory ring buffer that is
 * emptied on every host restart, which would silently flatten the chart.
 *
 * Counts follow the legacy sum semantics (see `llm-trace.ts`): billed input is
 * uncached input plus cache reads plus cache writes, because some adapters
 * report those disjointly and some fold them together.
 *
 * @module @deepseek-ai/dsh-chat-bots/src/token-usage
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

/** Days of daily history kept before pruning. */
const RETENTION_DAYS = 90

/** Days shown in the trend chart and in each model's daily breakdown. */
export const TREND_DAYS = 7

/** Prefix `models.routeIdFor` stamps on every provider route id. */
const ROUTE_PREFIX = 'chat-'

/**
 * One (model, day) bucket — the unit of storage and of every aggregation.
 *
 * `modelName` is a snapshot rather than a lookup: a model deleted from the
 * settings page must not retroactively blank out the history it generated.
 */
export interface TokenUsageRecord {
  readonly modelId: string
  readonly modelName: string
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string
  inputTokens: number
  outputTokens: number
  requests: number
}

/** One day of usage, as rendered by the charts. */
export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

/** Lifetime-to-date usage of one model, plus its recent daily history. */
export interface ModelUsage {
  modelId: string
  /** Latest known display name (snapshot for deleted models). */
  modelName: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  /** One entry per day in {@link TokenUsageReport.days}, zero-filled. */
  daily: DailyUsage[]
}

/** Everything the settings window renders. */
export interface TokenUsageReport {
  /** Ascending local dates covering the last {@link TREND_DAYS} days. */
  days: string[]
  /** Per-model totals, descending by `totalTokens`. */
  models: ModelUsage[]
  /** Summed across every model and every retained day. */
  grandTotal: Omit<DailyUsage, 'date'>
  /** All models combined, one entry per day in `days`. */
  daily: DailyUsage[]
}

export const tokenUsageRecordSchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  date: z.string(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
}) satisfies z.ZodType<TokenUsageRecord>

/** Resolves a model's current display name, or undefined once deleted. */
export type UsageModelResolver = (modelId: string) => { name: string } | undefined

/** Local calendar day of a timestamp — the bucketing key. */
function localDate(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${String(d.getFullYear())}-${month}-${day}`
}

/**
 * Recover the model id from a provider route id.
 *
 * Every chat-side call routes through `models.routeIdFor`, so `chat-<id>` is
 * the only shape worth accounting for; anything else (dsh built-ins such as
 * the web-search backend) has no model record to attribute to and is skipped
 * rather than booked under a bogus id.
 */
function modelIdFromRoute(provider: string | undefined): string | undefined {
  if (provider === undefined || !provider.startsWith(ROUTE_PREFIX)) return undefined
  const id = provider.slice(ROUTE_PREFIX.length)
  return id === '' ? undefined : id
}

/** Billed input: uncached + cache read + cache write (disjoint in dsh). */
function inputOf(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Local dates for the last `count` days, oldest first, ending today. */
export function recentDays(count: number, now: number = Date.now()): string[] {
  const base = new Date(now)
  base.setHours(12, 0, 0, 0) // noon avoids DST-induced day slips
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    days.push(localDate(d.getTime()))
  }
  return days
}

/**
 * Accumulates per-model, per-day token usage and durably persists it.
 *
 * Writes are batched through a memory buffer and flushed on a promise chain,
 * so a burst of tool-calling turns cannot interleave partial writes, and a
 * crash loses at most the in-flight tail rather than corrupting a day bucket.
 */
export class TokenUsageRecorder {
  /** Pending (model, day) deltas not yet durable, keyed `modelId|date`. */
  private readonly buffer = new Map<string, TokenUsageRecord>()

  /** Serializes flushes; every flush chains onto the previous one. */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly table: {
      get(key: string): TokenUsageRecord | undefined
      put(key: string, value: TokenUsageRecord): Promise<void>
      delete(key: string): Promise<boolean>
      entries(): IterableIterator<[string, TokenUsageRecord]>
    },
    private readonly resolveModel: UsageModelResolver,
  ) {
    ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) =>
      this.trackOne(options, next))
  }

  /** Aggregate report for the settings window. */
  report(now: number = Date.now()): TokenUsageReport {
    const days = recentDays(TREND_DAYS, now)
    const dayIndex = new Map(days.map((date, i) => [date, i]))
    const cutoff = days[0] ?? ''

    // name 取最新：优先当前模型的名字（可能已改名），已删除则用快照
    const byModel = new Map<string, ModelUsage>()
    const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 }
    const globalDaily: DailyUsage[] = days.map(date => ({
      date, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0,
    }))

    // Fold buffered deltas in so the window reflects calls not yet flushed.
    const pending = new Map<string, TokenUsageRecord>()
    for (const [key, rec] of this.buffer) {
      const stored = this.table.get(key)
      pending.set(key, stored === undefined
        ? { ...rec }
        : {
          ...stored,
          inputTokens: stored.inputTokens + rec.inputTokens,
          outputTokens: stored.outputTokens + rec.outputTokens,
          requests: stored.requests + rec.requests,
        })
    }

    for (const [key, rec] of this.table.entries()) {
      const merged = pending.get(key) ?? rec
      this.absorb(merged, byModel, globalDaily, dayIndex, totals, cutoff)
    }
    // Buckets that exist only in the buffer have no stored row to iterate.
    for (const [key, rec] of pending) {
      if (this.table.get(key) === undefined) {
        this.absorb(rec, byModel, globalDaily, dayIndex, totals, cutoff)
      }
    }

    const models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens)
    return { days, models, grandTotal: totals, daily: globalDaily }
  }

  /** Drop buckets older than the retention window. */
  async prune(now: number = Date.now()): Promise<void> {
    const cutoff = localDate(now - (RETENTION_DAYS - 1) * 86_400_000)
    for (const [key, rec] of [...this.table.entries()]) {
      if (rec.date < cutoff) await this.table.delete(key)
    }
  }

  /** Fold one bucket into the model map, the global series and the totals. */
  private absorb(
    rec: TokenUsageRecord,
    byModel: Map<string, ModelUsage>,
    globalDaily: DailyUsage[],
    dayIndex: Map<string, number>,
    totals: { inputTokens: number; outputTokens: number; totalTokens: number; requests: number },
    cutoff: string,
  ): void {
    const current = this.resolveModel(rec.modelId)
    let model = byModel.get(rec.modelId)
    if (model === undefined) {
      model = {
        modelId: rec.modelId,
        modelName: current?.name ?? rec.modelName,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requests: 0,
        daily: globalDaily.map(day => ({
          date: day.date, inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0,
        })),
      }
      byModel.set(rec.modelId, model)
    } else if (current !== undefined) {
      // 模型改名后以当前名为准
      model.modelName = current.name
    }

    model.inputTokens += rec.inputTokens
    model.outputTokens += rec.outputTokens
    model.totalTokens += rec.inputTokens + rec.outputTokens
    model.requests += rec.requests

    totals.inputTokens += rec.inputTokens
    totals.outputTokens += rec.outputTokens
    totals.totalTokens += rec.inputTokens + rec.outputTokens
    totals.requests += rec.requests

    // 只把落在趋势窗口内的天数计入折线；窗口外的历史仍计入总量
    const index = dayIndex.get(rec.date)
    if (index === undefined) return
    const slot = model.daily[index]
    const global = globalDaily[index]
    if (slot !== undefined) {
      slot.inputTokens += rec.inputTokens
      slot.outputTokens += rec.outputTokens
      slot.totalTokens += rec.inputTokens + rec.outputTokens
      slot.requests += rec.requests
    }
    if (global !== undefined) {
      global.inputTokens += rec.inputTokens
      global.outputTokens += rec.outputTokens
      global.totalTokens += rec.inputTokens + rec.outputTokens
      global.requests += rec.requests
    }
    void cutoff
  }

  /** Watch one model call and book its usage when the stream reports it. */
  private async *trackOne(
    options: GenerateOptions,
    next: () => AsyncIterable<StreamChunk>,
  ): AsyncIterable<StreamChunk> {
    const modelId = modelIdFromRoute(options.provider)
    for await (const chunk of next()) {
      if (modelId !== undefined && chunk.type === 'usage') {
        this.account(modelId, options.model, chunk.usage)
      }
      yield chunk
    }
  }

  /** Add one call's usage to the buffer and kick off a flush. */
  private account(modelId: string, modelName: string, usage: TokenUsage): void {
    const date = localDate(Date.now())
    const key = `${modelId}|${date}`
    const input = inputOf(usage)
    const existing = this.buffer.get(key)
    if (existing === undefined) {
      this.buffer.set(key, {
        modelId,
        modelName: this.resolveModel(modelId)?.name ?? modelName,
        date,
        inputTokens: input,
        outputTokens: usage.outputTokens,
        requests: 1,
      })
    } else {
      existing.inputTokens += input
      existing.outputTokens += usage.outputTokens
      existing.requests += 1
    }
    void this.flush()
  }

  /** Persist buffered deltas, serialized so concurrent flushes never interleave. */
  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (this.buffer.size === 0) return
      const batch = [...this.buffer.entries()]
      this.buffer.clear()
      for (const [key, delta] of batch) {
        try {
          const stored = this.table.get(key)
          const next: TokenUsageRecord = stored === undefined
            ? delta
            : {
              modelId: stored.modelId,
              // 名称以最新为准：改名后旧桶也应显示新名字
              modelName: this.resolveModel(stored.modelId)?.name ?? delta.modelName,
              date: stored.date,
              inputTokens: stored.inputTokens + delta.inputTokens,
              outputTokens: stored.outputTokens + delta.outputTokens,
              requests: stored.requests + delta.requests,
            }
          await this.table.put(key, next)
        } catch (error: unknown) {
          // 记账失败不能影响对话；丢弃该批次，下一轮调用会重新累计
          this.ctx.logger?.warn?.('chat-bots token usage: %o', error)
        }
      }
    })
    return this.writing
  }
}
