/**
 * The zod schema of one durable bot record (the storage-domain value shape).
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { BotRecord } from './types.ts'

const triggerSchema = z.object({
  activeRate: z.number().min(0).max(1),
  keywords: z.array(z.string()),
  cooldownSeconds: z.number().int().nonnegative(),
})

export const botRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatar: z.string().optional(),
  persona: z.string(),
  provider: z.string(),
  model: z.string(),
  trigger: triggerSchema,
  sessionId: z.string().transform(SessionId),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<BotRecord>
