import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  BlockAssembler,
  createUserMessage,
  LlmError,
  ReasoningEffortId,
  type ContentBlock,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'

/**
 * Per-bot long-term memory, stored OUTSIDE the agent session so it survives
 * `clear()` (which swaps the session id and deletes the session log).
 *
 * Layout: `<workspaceDir>/memory/MEMORY.md`
 */

/** Directory name inside the bot's workspace. */
const MEMORY_DIR = 'memory'

/** Memory file name; also what the bot sees when it reads its own workspace. */
const MEMORY_FILE = 'MEMORY.md'

/** Max source rows fed to the consolidation call. */
const SOURCE_ROW_LIMIT = 200

/** Max source characters; the newest rows win (older content is already distilled). */
const SOURCE_CHAR_LIMIT = 60_000

/** Max tokens for the rewritten memory document. */
const MAX_OUTPUT_TOKENS = 4096

/** Fixed section headings — keeps the document stable across rewrites. */
const MEMORY_SECTIONS: readonly string[] = [
  '## 关于用户',
  '## 我们的共同经历',
  '## 用户的偏好与忌讳',
  '## 我的性格沉淀',
]

/**
 * One turn of conversation fed into consolidation. Deliberately minimal
 * (`kind`/`time`/`text`) so both the private-chat row projection and the
 * group relay transcript can be sources without extra coupling (ISP).
 */
export interface MemorySourceRow {
  readonly kind: 'user' | 'assistant'
  readonly time: number
  readonly text: string
}

/** Absolute path of one bot's memory file, or undefined without a workspace. */
function memoryPath(workspaceDir: string | undefined): string | undefined {
  if (workspaceDir === undefined || workspaceDir === '') return undefined
  return join(workspaceDir, MEMORY_DIR, MEMORY_FILE)
}

/** Read one bot's memory document; empty string when absent or unreadable. */
export async function readMemory(workspaceDir: string | undefined): Promise<string> {
  const path = memoryPath(workspaceDir)
  if (path === undefined) return ''
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch {
    return ''
  }
}

/**
 * Last consolidation time (file mtime), so the UI can show "整理于 …" without
 * a separate metadata file. Undefined when no memory exists yet.
 */
export async function memoryUpdatedAt(workspaceDir: string | undefined): Promise<number | undefined> {
  const path = memoryPath(workspaceDir)
  if (path === undefined) return undefined
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return undefined
  }
}

/** Overwrite one bot's memory document, creating `memory/` when needed. */
export async function writeMemory(workspaceDir: string | undefined, text: string): Promise<void> {
  if (workspaceDir === undefined || workspaceDir === '') return
  await mkdir(join(workspaceDir, MEMORY_DIR), { recursive: true })
  const content = text.trim()
  await writeFile(join(workspaceDir, MEMORY_DIR, MEMORY_FILE), `${content}\n`, 'utf8')
}

/** Concatenate the text of a content-block list. */
function plainText(blocks: readonly ContentBlock[] | undefined): string {
  if (blocks === undefined) return ''
  return blocks
    .filter((block): block is ContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map(block => block.text.trim())
    .filter(text => text !== '')
    .join('\n')
}

/**
 * Pull a flat conversation transcript out of ANY agent session.
 *
 * Group bot-sessions store the rendered group transcript as plugin-injected
 * relay messages, so the private-chat row projection (which keys on real user
 * prompts) yields nothing there. This generic walker covers both: relay text
 * counts as conversation, `notice` nudges are skipped as scaffolding.
 */
export function extractTranscript(session: Session): MemorySourceRow[] {
  const rows: MemorySourceRow[] = []
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: string; form?: string } | undefined
      if (source?.form === 'notice') continue
      const text = plainText(event.data.content as readonly ContentBlock[] | undefined)
      if (text !== '') rows.push({ kind: 'user', time: event.time, text })
      continue
    }
    if (event.type === 'assistant/message') {
      const message = event.data.message as { content?: readonly ContentBlock[] } | undefined
      const text = plainText(message?.content)
      if (text !== '') rows.push({ kind: 'assistant', time: event.time, text })
    }
  }
  return rows
}

/**
 * Trim the source to the newest rows that fit the budget. Older content is
 * already distilled into the existing memory document, so dropping it loses
 * nothing but keeps the call cost constant as history grows.
 */
function renderSource(rows: readonly MemorySourceRow[]): string {
  const recent = rows.slice(-SOURCE_ROW_LIMIT)
  const kept: string[] = []
  let total = 0
  for (let i = recent.length - 1; i >= 0; i--) {
    const row = recent[i]
    if (row === undefined || row.text === '') continue
    if (total + row.text.length > SOURCE_CHAR_LIMIT) break
    total += row.text.length
    kept.unshift(`${row.kind === 'user' ? '用户' : '我'}：${row.text}`)
  }
  return kept.join('\n\n')
}

/** The consolidation instruction: merge old memory + this transcript into a new document. */
function consolidationPrompt(previous: string, source: string, botName: string): string {
  return [
    `你是「${botName}」。你和这位用户刚结束一段对话，现在要把这段关系沉淀成长期记忆，写入你的记忆文件。`,
    '',
    '## 任务',
    '结合【已有记忆】与【本段对话】，重写一份完整的记忆文件。保留仍然成立的内容，丢弃已经过时的内容，把新信息合并进已有结构。',
    '',
    '## 输出格式',
    '严格输出一个 Markdown 文档，只包含以下四个二级标题，顺序固定，不要增删标题：',
    ...MEMORY_SECTIONS.map(heading => `- ${heading}`),
    '每个小节下用 2-6 条要点（`- ` 开头）。某小节确实没有内容时写 `(无)`。',
    '',
    '## 写作要求',
    '- 用第一人称「我」自称，用「用户」或用户的自称指代对话对象。',
    '- 记录具体事实、偏好与关系认知，不要复述对话流水账；把具体事件抽象成对性格、关系、偏好的认识。',
    '- 不要写「在本次对话中」这类时间限定语——记忆是跨会话长期持有的。',
    '- 总长度控制在 1200 字以内。',
    '- 只输出记忆文档本身，不要任何前言、解释或代码块围栏。',
    '',
    '## 已有记忆',
    previous === '' ? '(这是第一次沉淀，尚无已有记忆)' : previous,
    '',
    '## 本段对话',
    source,
  ].join('\n')
}

/** One consolidation call's inputs. */
export interface ConsolidateOptions {
  /** Host context providing the LLM seam. */
  readonly ctx: Context
  /** Bot display name, so the writer keeps its voice. */
  readonly botName: string
  /** Bot workspace; memory is skipped when undefined. */
  readonly workspaceDir: string | undefined
  /** Conversation to distill (already snapshot — safe to use after session deletion). */
  readonly rows: readonly MemorySourceRow[]
  /** Provider route id (see `models.routeIdFor`). */
  readonly provider: string
  /** Provider model name. */
  readonly model: string
}

/**
 * Rewrite the bot's memory document from the previous memory plus a
 * conversation transcript. One auxiliary LLM call, no tools, no agent loop.
 *
 * @returns true when a new document was written, false when there was nothing
 * to distill (empty transcript) or the model returned no text.
 */
export async function consolidateMemory(options: ConsolidateOptions): Promise<boolean> {
  const source = renderSource(options.rows)
  if (source === '') return false

  const previous = await readMemory(options.workspaceDir)
  const assembler = new BlockAssembler()
  const request: GenerateOptions = {
    provider: options.provider,
    model: options.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: consolidationPrompt(previous, source, options.botName) }],
      source: { kind: 'plugin', plugin: 'dsh-chat-bots' },
    })],
    maxTokens: MAX_OUTPUT_TOKENS,
    // 总结是一次后台批处理：开思维链只会拖慢蒸馏、白烧 token。
    // 注意：'off' 并非所有模型都有这一档（pi-ai 手工声明的自定义端点没有
    // reasoning 元数据，显式请求任何档位都会被 resolveCallConfig 拒绝），
    // 所以先探一次能力，不支持就退化为不指定——蒸馏必须比"关思维链"更优先。
    reasoningEffort: ReasoningEffortId('off'),
  }

  let finalRequest = request
  try {
    await options.ctx.llm.resolveCallConfig(request)
  } catch (error: unknown) {
    if (error instanceof LlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT') {
      // exactOptionalPropertyTypes：不能用 reasoningEffort: undefined 覆盖，
      // 解构剔除该键
      const { reasoningEffort: _omit, ...rest } = request
      finalRequest = rest
    } else {
      throw error
    }
  }

  for await (const chunk of options.ctx.llm.stream(finalRequest)) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind !== 'stop') {
    const detail = finish as { kind: string; error?: unknown }
    throw detail.error instanceof Error
      ? detail.error
      : new Error(`chat-bots: memory consolidation stream ended with "${finish.kind}"`)
  }

  const text = plainText(assembler.blocks())
  if (text === '') return false
  await writeMemory(options.workspaceDir, text)
  return true
}
