/**
 * The zod schema of one durable group record.
 *
 * @module @deepseek-ai/dsh-chat-group
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'

export const groupRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  memberBotIds: z.array(z.string()),
  sessionId: z.string().transform(SessionId),
  workspaceDir: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/** One per-(group, bot) chat session binding: the bot's group-chat memory. */
export const botSessionRecordSchema = z.object({
  sessionId: z.string().transform(SessionId),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})

/**
 * One stored domain setting value.
 *
 * Settings are kept as plain strings so that introducing a new key never
 * requires a domain migration — the reader decides how to interpret it.
 */
export const settingValueSchema = z.string()
