/**
 * Public types of the chat-agent bot registry.
 *
 * @module @deepseek-ai/dsh-chat-bots/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Group-chat trigger policy carried by every bot record. */
export interface TriggerConfig {
  /** Base probability that this bot replies to an ordinary group message. */
  readonly activeRate: number
  /** Reply-probability boost keywords; a hit samples the same rate. */
  readonly keywords: readonly string[]
  /** Minimum silence window (seconds) between this bot's group replies. */
  readonly cooldownSeconds: number
}

/** One durable AI-companion record (chat-agent's `ai_bots` successor). */
export interface BotRecord {
  /** Stable identity; also the storage key. */
  readonly id: string
  /** Display name; `@name` in a group mentions this bot. */
  readonly name: string
  /** Local avatar path or built-in asset id. */
  readonly avatar?: string | undefined
  /** Persona text injected as this bot's agent persona prompt section. */
  readonly persona: string
  /** Provider route of this bot's model. */
  readonly provider: string
  /** Model id interpreted by the provider adapter. */
  readonly model: string
  /** Group trigger policy. */
  readonly trigger: TriggerConfig
  /** The persistent per-bot session identity (bot memory). */
  readonly sessionId: SessionId
  /** Soft-delete tombstone: deleted bots keep their session history. */
  readonly deletedAt?: number | undefined
  /** Bot self-introduction line (conversation list subtitle). */
  readonly introduction?: string | undefined
  /** Explicit agent-capability switch (UI level; the workspace may exist regardless). */
  readonly agentEnabled?: boolean | undefined
  /** Per-bot agent workspace directory, when agent mode is on. */
  readonly workspaceDir?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input accepted by bot creation (identity and timestamps are minted). */
export type BotCreateInput = Omit<BotRecord, 'id' | 'sessionId' | 'createdAt' | 'updatedAt' | 'trigger'> & {
  readonly trigger?: TriggerConfig | undefined
}

/** Patch accepted by bot update; every field is optional. */
export type BotUpdatePatch = Partial<Omit<BotRecord, 'id' | 'sessionId' | 'createdAt'>>
