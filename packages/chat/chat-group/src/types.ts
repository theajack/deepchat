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
  /** Fixed group workspace: $DSH_HOME/workspace/groups/{uid}. */
  readonly workspaceDir?: string | undefined
  readonly createdAt: number
  readonly updatedAt: number
}

/** Input accepted by group creation. */
export type GroupCreateInput = Pick<GroupRecord, 'name'> & {
  readonly avatar?: string | undefined
  readonly memberBotIds?: readonly string[] | undefined
}

/** Patch accepted by group update. */
export type GroupUpdatePatch = Partial<Pick<GroupRecord, 'name' | 'avatar' | 'memberBotIds'>>

/** One rendered chat row served by `history()`. */
export interface GroupMessageView {
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'bot'
  /** Bot id on `bot` rows; `'user'` on human rows. */
  readonly senderId: string
  readonly senderName: string
  readonly text: string
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
    /** One bot reply landed in the group. */
    'group/bot-message': {
      readonly botId: string
      readonly botName: string
      readonly text: string
    }
  }
}
