import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type FinishReason, type GenerateOptions } from '@deepseek-ai/dsh-llm'

/**
 * One-shot auxiliary text generation: bot persona, the user's self
 * introduction, or a group-chat description.
 *
 * These are plain LLM completions — no tools, no agent loop, no session — and
 * always run on the **general-purpose model** (the one configured in settings),
 * never on the bot's own chat model: the user expects a fast, predictable
 * edit-assistant response, not their bot talking to itself.
 *
 * @module dsh-chat-bots/persona
 */

/** Which piece of text to generate. */
export type PersonaKind = 'botPersona' | 'selfIntro' | 'groupIntro'

/** Everything one generation call needs. */
export interface PersonaGenerateOptions {
  readonly ctx: Context
  readonly kind: PersonaKind
  /** Provider route id (see `models.routeIdFor`). */
  readonly provider: string
  /** Provider model name. */
  readonly model: string
  /** Subject name: bot name, my nickname, or group name. */
  readonly name: string
  /** Text the user already typed; treated as a base to polish, never discarded. */
  readonly partial?: string
  /** Group member display names; only read by `groupIntro`. */
  readonly memberNames?: readonly string[]
  /** Receives each text delta as it arrives, for live streaming into the UI. */
  readonly onDelta?: (delta: string) => void
  /** Aborts the underlying request. */
  readonly signal?: AbortSignal
}

/** Output ceiling; all three kinds are short-form prose. */
const MAX_OUTPUT_TOKENS = 2048

const BOT_PERSONA_SYSTEM = `你是一名资深的 AI 人设设计师。用户会给你 AI 好友的名称和（可选的）已有人设片段，你的任务是产出**完整、可直接作为 system prompt 注入**的人设描述。

要求：
1. 输出纯中文，结构清晰，使用 3-6 段或带 "性格" "说话风格" "擅长领域" "行为边界" 等小标题
2. 结合名称暗示的气质（古风/二次元/职场等），不要凭空编造与名称矛盾的设定
3. 长度 200-400 字之间，既要具体（举出说话示例/口头禅）又不能空泛
4. 不输出任何前缀解释、寒暄或代码块，直接产出人设正文
5. 如果用户给了片段，把它作为基底补全/润色，不要丢弃用户已经写的内容`

const SELF_INTRO_SYSTEM = `你是一名社交文案专家。用户会给你 TA 的昵称和（可选的）已有自我介绍片段，你的任务是产出**完整、自然、可直接使用**的第一人称自我介绍。

要求：
1. 输出纯中文，第一人称（"我"），语气自然亲切
2. 长度 80-200 字，既具体有趣又不冗长
3. 结合昵称暗示的性格气质，可以适当加一些趣味性描述
4. 如果用户给了已有片段，把它作为基底补全/润色，不要丢弃用户已经写的内容
5. 不输出任何前缀解释、寒暄或代码块，直接产出自我介绍正文`

const GROUP_INTRO_SYSTEM = `你是一名社群文案专家。用户会给你群聊名称和成员名单，你的任务是产出**自然、有吸引力、可直接使用**的群聊介绍。

要求：
1. 输出纯中文，长度 60-180 字
2. 结合群名称暗示的主题氛围（摸鱼/技术/读书/生活等），点出这个群大概会聊什么
3. 成员名字里带职业或兴趣暗示时可以自然带一笔，但不要逐个罗列成员
4. 语气轻松自然，可以有轻微幽默感
5. 如果用户给了已有片段，把它作为基底补全/润色，不要丢弃用户已经写的内容
6. 不输出任何前缀解释、寒暄或代码块，直接产出群聊介绍正文`

/** The system prompt for one kind. */
function systemFor(kind: PersonaKind): string {
  switch (kind) {
    case 'botPersona': return BOT_PERSONA_SYSTEM
    case 'selfIntro': return SELF_INTRO_SYSTEM
    case 'groupIntro': return GROUP_INTRO_SYSTEM
  }
}

/** The user-turn prompt for one kind, folding in whatever the user typed. */
function userPrompt(options: PersonaGenerateOptions): string {
  const partial = options.partial?.trim() ?? ''
  const existing = partial === '' ? '（用户未填）' : partial
  switch (options.kind) {
    case 'botPersona':
      return `AI 好友名称：${options.name}\n\n已有人设片段：${existing}\n\n请生成完整人设：`
    case 'selfIntro':
      return `我的昵称：${options.name}\n\n已有自我介绍片段：${existing}\n\n请帮我生成一段完整的自我介绍：`
    case 'groupIntro': {
      const members = options.memberNames?.filter(name => name.trim() !== '') ?? []
      const roster = members.length === 0 ? '（暂未选择成员）' : members.join('、')
      return `群聊名称：${options.name}\n\n群成员：${roster}\n\n已有群聊介绍片段：${existing}\n\n请生成群聊介绍：`
    }
  }
}

/** The participant attribution an auxiliary call must carry. */
const SOURCE = { kind: 'plugin', plugin: 'dsh-chat-bots' } as const

/**
 * Run one auxiliary generation and return the trimmed text.
 *
 * Reasoning deltas are dropped so a thinking model's chain-of-thought never
 * leaks into the field the user is editing.
 *
 * @throws when the stream ends on a non-`stop` finish reason.
 */
export async function generatePersonaText(options: PersonaGenerateOptions): Promise<string> {
  const request: GenerateOptions = {
    provider: options.provider,
    model: options.model,
    system: systemFor(options.kind),
    messages: [createUserMessage({
      content: [{ type: 'text', text: userPrompt(options) }],
      source: SOURCE,
    })],
    maxTokens: MAX_OUTPUT_TOKENS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }

  let text = ''
  let finish: FinishReason | undefined
  for await (const chunk of options.ctx.llm.stream(request)) {
    if (chunk.type === 'text-delta') {
      text += chunk.text
      options.onDelta?.(chunk.text)
      continue
    }
    if (chunk.type === 'finish') finish = chunk.reason
  }

  if (finish !== undefined && finish.kind !== 'stop') {
    const detail = finish as { failure?: { message?: string } }
    throw new Error(detail.failure?.message ?? `chat-bots: persona stream ended with "${finish.kind}"`)
  }
  return text.trim()
}
