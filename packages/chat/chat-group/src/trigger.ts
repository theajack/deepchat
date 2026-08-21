/**
 * The group-chat trigger rule engine, ported from chat-agent's
 * `cli/src/core/trigger.ts` onto bot records.
 *
 * Evaluation priority:
 * 1. `@name` in the message → must reply (cooldown exempt)
 * 2. inside the bot's cooldown window → skip
 * 3. keyword hit → reply with `activeRate` probability
 * 4. otherwise → reply with `activeRate` probability
 *
 * @module @deepseek-ai/dsh-chat-group/trigger
 */

import type { BotRecord } from '@deepseek-ai/dsh-chat-bots'

/** One message under evaluation. */
export interface TriggerMessage {
  /** Sender identity: `'user'` or the bot id; a sender never triggers itself. */
  readonly senderId: string
  /** Display name of the sender (used by the cascade context renderer). */
  readonly senderName?: string | undefined
  readonly text: string
}

/** Evaluation context. */
export interface TriggerContext {
  /** This bot's last group reply time (epoch ms), or null. */
  readonly lastSpokeAt: number | null
  readonly now: number
  /** Random source, injectable for tests. */
  readonly random: () => number
}

/** Decide whether one bot responds to one group message. */
export function shouldRespond(bot: BotRecord, message: TriggerMessage, ctx: TriggerContext): boolean {
  if (message.senderId === bot.id) return false

  // 1. A direct mention must reply, even inside the cooldown window.
  if (message.text.includes(`@${bot.name}`)) return true

  // 2. Cooldown.
  if (ctx.lastSpokeAt !== null && ctx.now - ctx.lastSpokeAt < bot.trigger.cooldownSeconds * 1000) {
    return false
  }

  // 3. Keyword hit → probability.
  const hitKeyword = bot.trigger.keywords.some(keyword => keyword !== '' && message.text.includes(keyword))
  if (hitKeyword) return ctx.random() < bot.trigger.activeRate

  // 4. Base probability.
  return ctx.random() < bot.trigger.activeRate
}
