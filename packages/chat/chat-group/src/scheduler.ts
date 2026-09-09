/**
 * The group-speaking scheduler.
 *
 * One auxiliary call to a general-purpose model replaces the old per-member
 * probability roll: it reads the recent transcript plus every candidate's
 * persona, and returns the ordered list of bots that should speak next.
 *
 * This is deliberately NOT an agent call — no tools, no session, no memory.
 * A scheduling decision ("stay silent") must not be recorded as something the
 * bot said.
 *
 * @module @deepseek-ai/dsh-chat-group/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Max tokens for the scheduling verdict. */
const MAX_OUTPUT_TOKENS = 512

/** Max characters of one candidate's persona, to bound the input. */
const PERSONA_LIMIT = 200

/** Max characters of the transcript handed to the scheduler. */
const CONTEXT_LIMIT = 12_000

/** One bot the scheduler may pick. */
export interface ScheduleCandidate {
  readonly id: string
  readonly name: string
  readonly persona: string
  /** Topics this bot cares about; a hint, not a matching rule. */
  readonly topics: readonly string[]
  /** Seconds since this bot last spoke, or null when it never has. */
  readonly silentForSeconds: number | null
}

/** Inputs for one scheduling call. */
export interface ScheduleRequest {
  readonly ctx: Context
  /** Group display name, for a bit of framing. */
  readonly groupName: string
  /** Rendered recent transcript, oldest first. */
  readonly transcript: string
  /**
   * Who produced the newest message.
   *
   * Without this the model sees its own last line and either picks it (not a
   * candidate — bots cannot reply to themselves, so it gets filtered out and
   * the round comes back empty) or decides nobody needs to answer.
   */
  readonly lastSpeakerName: string
  readonly candidates: readonly ScheduleCandidate[]
  /** Hard cap on how many bots may speak this round. */
  readonly maxSpeakers: number
  /**
   * 连续无用户参与的 AI 对话轮数（供疲劳机制提示用；缺省 0 = 用户刚说过话）。
   */
  readonly aiOnlyRounds?: number
  /** 疲劳阈值：aiOnlyRounds 超过它后提示调度者提高未指向回复的门槛。 */
  readonly fatigueStart?: number
  /** Provider route id. */
  readonly provider: string
  /** Provider model name. */
  readonly model: string
}

/** Truncate a persona to a single readable line. */
function briefPersona(persona: string): string {
  const flat = persona.replace(/\s+/g, ' ').trim()
  if (flat === '') return '（无特别设定）'
  return flat.length > PERSONA_LIMIT ? `${flat.slice(0, PERSONA_LIMIT - 1)}…` : flat
}

/** Render the candidate roster the scheduler chooses from. */
function renderCandidates(candidates: readonly ScheduleCandidate[]): string {
  return candidates.map((candidate) => {
    const topics = candidate.topics.length === 0 ? '无' : candidate.topics.join('、')
    const silence = candidate.silentForSeconds === null
      ? '本群还没说过话'
      : `${Math.round(candidate.silentForSeconds)} 秒没说话`
    return [
      `- id: ${candidate.id}`,
      `  名称: ${candidate.name}`,
      `  人设: ${briefPersona(candidate.persona)}`,
      `  关注话题: ${topics}`,
      `  最近状态: ${silence}`,
    ].join('\n')
  }).join('\n')
}

/** The scheduling instruction. */
function schedulingPrompt(request: ScheduleRequest): string {
  const transcript = request.transcript.length > CONTEXT_LIMIT
    ? `…${request.transcript.slice(-CONTEXT_LIMIT)}`
    : request.transcript
  const aiOnly = request.aiOnlyRounds ?? 0
  const fatigueStart = request.fatigueStart ?? Number.POSITIVE_INFINITY
  // 超过阈值后，每多一轮提示强度递增（封顶，避免提示词膨胀）
  const fatigueExcess = aiOnly > fatigueStart ? Math.min(aiOnly - fatigueStart, 6) : 0
  const fatigueSection = fatigueExcess > 0
    ? [
      '',
      '## 特别注意：对话已经自我延续很久了',
      `成员们已经连续 ${String(aiOnly)} 轮在没有用户参与的情况下互相接话。`,
      '这种自我延续往往没有价值，甚至在原地打转。请大幅提高开口门槛：',
      '- 只有最新消息**明确点名、@、或直接提问**某位候选成员时，才选择他',
      '- 纯粹的附和、礼貌性回应、没有新信息的补充，一律不要选',
      '- 拿不准时输出 []，让对话自然停下——此时安静比继续更有价值',
    ]
    : []
  return [
    `你是群聊「${request.groupName}」的发言调度者。`,
    '',
    ...fatigueSection,
    '## 你的任务',
    '判断下面这些群成员中，谁应该对「最新的消息」作出回应。你不是要代替他们说话，只是决定「谁该开口」。',
    '',
    '## 重要前提',
    `最新那条消息是「${request.lastSpeakerName}」发出的。`,
    `${request.lastSpeakerName} 不在下面的候选列表中（成员不能回复自己），你不能选择它。`,
    '你的任务只有一个：判断候选列表里的成员，谁该接上这条最新消息。',
    '',
    '## 输出格式',
    '只输出一个 JSON 数组，元素是候选成员的 id 字符串。',
    `最多 ${String(request.maxSpeakers)} 个。如果确实没有人需要说话，输出 []。`,
    '不要输出任何解释、前言或代码块围栏。',
    '重要：只从上面的候选成员中选择，绝对不要输出不在候选列表中的人。',
    '优先输出 id（如 "bot-xxxx"）；写成员名称也可以，系统会自动匹配。',
    '重要：不要在数组中包含用户名、人名或其他非 id 的字符串——只允许候选列表中的 id。',
    '## 判断依据（按优先级）',
    '1. 最新消息明确向他提问、@ 他、或涉及他的专业/兴趣领域 → 必须选他',
    '2. 最新消息是问句、邀请、提议、或话题明显没有收尾 → 至少选一个人接上',
    '3. 话题已经聊了一轮、暂时没人接 → 选一个最相关的人补充或追问，让对话继续流动',
    '',
    '## 重要倾向：宁可多说一句，也不要冷场',
    '- 你的默认答案是「让人说话」。这是一个需要活跃气氛的群聊，冷场比多说一句更糟糕。',
    '- 只有两种情况下才输出 []：最新消息是明确结束语（如"好""再见""先这样"），或所有候选都与该话题完全无关。',
    '- 不要因为"他可能没兴趣""他话少"就把人筛掉——被点到的人可以只回一句简短的话，这比无人回应好得多。',
    '- 简短附和、追问细节、补充一个观点、表达不同看法，都算有价值的发言。不要把"值得开口"的标准定得太高。',
    '- 拿不准的时候，选一个人。',
    '',
    '## 输出格式',
    '只输出一个 JSON 数组，元素为成员的 id 字符串，顺序就是发言的先后顺序。',
    `最多 ${String(request.maxSpeakers)} 个。如果确实没有人需要说话，输出 []。`,
    '不要输出任何解释、前言或代码块围栏。',
    '重要：只从上面的候选成员中选择，绝对不要输出不在候选列表中的 id。',
    '',
    '## 群聊记录（由旧到新）',
    transcript === '' ? '（暂无记录）' : transcript,
    '',
    '## 候选成员',
    renderCandidates(request.candidates),
  ].join('\n')
}

/**
 * Extract the ordered speaker ids from a model's reply.
 *
 * Models are unreliable: they wrap arrays in prose, use single quotes, output
 * the member's display name instead of its id, or hallucinate entirely. Each
 * entry is resolved id-first and name-second, so a reply naming members (a
 * very natural thing for a model to do, and the common failure in practice)
 * still resolves instead of silently producing silence.
 *
 * Every unresolvable entry is skipped rather than guessed at — silence is
 * always safer than making someone speak out of turn.
 */
export function parseSpeakerIds(
  raw: string,
  candidates: readonly ScheduleCandidate[],
  maxSpeakers: number,
): string[] {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const picked: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue
    const id = resolveSpeakerId(entry, candidates)
    if (id === undefined || picked.includes(id)) continue
    picked.push(id)
    if (picked.length >= maxSpeakers) break
  }
  return picked
}

/**
 * Resolve one array entry to a candidate id, accepting either the id or the
 * member's display name.
 *
 * Name matching is deliberately forgiving: models also emit `@name`,
 * `"name"`, or a name with stray whitespace/quotes around it.
 */
function resolveSpeakerId(
  entry: string,
  candidates: readonly ScheduleCandidate[],
): string | undefined {
  // Normalize away the decorations models like to add: @-mentions, quotes,
  // brackets and whitespace.
  const value = entry.trim().replace(/^@+/, '').replace(/^["'「『【]+|["'」』】]+$/g, '').trim()
  if (value === '') return undefined

  const exactId = candidates.find(candidate => candidate.id === value)
  if (exactId !== undefined) return exactId.id

  const lower = value.toLowerCase()
  const exactName = candidates.find(candidate => candidate.name.toLowerCase() === lower)
  if (exactName !== undefined) return exactName.id

  // Last resort: a name contained in the entry (e.g. "让 小明 来回答").
  return candidates.find((candidate) => {
    const name = candidate.name.toLowerCase()
    return name !== '' && lower.includes(name)
  })?.id
}

/**
 * Ask the general-purpose model who should speak next.
 *
 * @returns ordered, de-duplicated, validated bot ids; empty when the model is
 * undecidable, returns nothing, or the call fails. Callers must treat an empty
 * result as "nobody speaks this round".
 */
export async function scheduleSpeakers(request: ScheduleRequest): Promise<string[]> {
  if (request.candidates.length === 0 || request.maxSpeakers <= 0) return []

  const assembler = new BlockAssembler()
  const options: GenerateOptions = {
    provider: request.provider,
    model: request.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: schedulingPrompt(request) }],
      source: { kind: 'plugin', plugin: 'chat-group' },
    })],
    maxTokens: MAX_OUTPUT_TOKENS,
  }

  for await (const chunk of request.ctx.llm.stream(options)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind !== 'stop') return []

  const text = assembler.blocks()
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
  return parseSpeakerIds(text, request.candidates, request.maxSpeakers)
}
