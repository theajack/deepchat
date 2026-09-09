/**
 * Public types of the chat-agent group orchestration.
 *
 * @module @deepseek-ai/dsh-chat-group/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** One durable group record. */
export interface GroupRecord {
  /** Stable identity; also the storage key. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Local avatar path or built-in asset id. */
  readonly avatar?: string | undefined
  /** Member bot ids (bot registry keys), in join order. */
  readonly memberBotIds: readonly string[]
  /** The group container session: the shared message log the UI renders. */
  readonly sessionId: SessionId
  /**
   * Shared group workspace — `$DSH_HOME/workspace/groups/{uid}` by default, or
   * a user-chosen directory.
   *
   * Members may use this shared area or their own private workspace; both are
   * announced in the per-turn context so the model can pick. It is fixed at
   * creation time: the container agent's cwd and any files the group produced
   * are anchored to it, so repointing later would orphan them.
   */
  readonly workspaceDir?: string | undefined
  /**
   * 自主对话疲劳阈值：连续无用户参与的 AI 对话轮数超过该值后，没有明确
   * 指向（未被 @）的回复会越来越难被触发，防止成员之间无限互相接话。
   * 缺省 5；用户在群里的每次发言都会重置计数。
   */
  readonly aiFatigueRounds?: number | undefined
  /**
   * 当用户 @ 某位成员时，其他未被 @ 的成员是否也回复该消息。
   * 缺省（undefined/false）= 不回复：被 @ 的成员直接答，跳过调度者；
   * true = 走正常调度，其他成员也可能插话。
   */
  readonly mentionOthersReply?: boolean | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input accepted by group creation. */
export type GroupCreateInput = Pick<GroupRecord, 'name'> & {
  readonly avatar?: string | undefined
  readonly memberBotIds?: readonly string[] | undefined
  /**
   * Optional shared workspace. Omitted (or blank) falls back to
   * `$DSH_HOME/workspace/groups/{uid}`.
   */
  readonly workspaceDir?: string | undefined
  /** 自主对话疲劳阈值（见 {@link GroupRecord.aiFatigueRounds}）。 */
  readonly aiFatigueRounds?: number | undefined
  /** @ 时其他成员是否也可回复（见 {@link GroupRecord.mentionOthersReply}）。 */
  readonly mentionOthersReply?: boolean | undefined
}

/**
 * Patch accepted by group update.
 *
 * `workspaceDir` is deliberately absent — creation-time only, for the reason
 * documented on {@link GroupRecord.workspaceDir}.
 */
export type GroupUpdatePatch = Partial<Pick<GroupRecord, 'name' | 'avatar' | 'memberBotIds' | 'aiFatigueRounds' | 'mentionOthersReply'>>

/** One rendered chat row served by `history()`. */
export interface GroupMessageView {
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'bot'
  /** Bot id on `bot` rows; `'user'` on human rows. */
  readonly senderId: string
  readonly senderName: string
  readonly text: string
  readonly segments?: Array<{ type: 'reasoning' | 'text' | 'tool'; content: string; toolId?: string }>
  readonly toolCalls?: Array<{
    id: string
    name: string
    args?: unknown
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    isError?: boolean
  }>
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly cachedTokens?: number
  readonly durationMs?: number
}

/**
 * Durable group-container session events. The container session never reaches
 * a model, so these carry no surface metadata; the UI projection and the
 * cascade context renderer consume them from the event log.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** A human message entered the group. */
    'group/user-message': { readonly text: string; readonly senderName: string }
    /** One bot reply landed in the group (with the run's aggregate stats). */
    'group/bot-message': {
      readonly botId: string
      readonly botName: string
      readonly text: string
      readonly promptTokens?: number
      readonly completionTokens?: number
      readonly cachedTokens?: number
      readonly durationMs?: number
      readonly segments?: Array<{ type: 'reasoning' | 'text' | 'tool'; content: string; toolId?: string }>
      readonly toolCalls?: Array<{
        id: string
        name: string
        args?: unknown
        result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
        isError?: boolean
      }>
    }
  }
}
