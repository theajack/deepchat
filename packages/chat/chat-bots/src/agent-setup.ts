/**
 * Shared per-bot agent capability wiring used by both the private-chat
 * (chat-bots) and group-chat (chat-group) agent factories: the persona prompt
 * section, the agent-disable triple guard, the per-bot tool whitelist, and
 * the enabled-skill catalog with its scoped `skill` loader tool.
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import type { Context } from '@deepseek-ai/cordis'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isSkillName, renderSkillContent } from '@deepseek-ai/dsh-skill'
import { registerReadDocumentTool } from './read-document.ts'
import type { BotRecord } from './types.ts'

/** One model-invocable enabled-skill catalog entry, resolved before agent creation (setup stays sync). */
export interface EnabledSkillSummary {
  readonly name: string
  readonly description: string
}

/**
 * Resolve the model-invocable summaries of a bot's enabled skills from the
 * global skill registry. An empty whitelist means no skills (chat companions
 * deliberately do not inherit the whole dev skill catalog).
 */
export async function resolveEnabledSkills(ctx: Context, bot: BotRecord): Promise<EnabledSkillSummary[]> {
  const names = bot.enabledSkills ?? []
  if (names.length === 0) return []
  const wanted = new Set(names)
  const snapshot = await ctx.skills.snapshot()
  return snapshot.skills
    .filter(skill => wanted.has(skill.name) && skill.invocation.modelInvocable)
    .map(skill => ({ name: skill.name, description: skill.description }))
}

/** Render the model-facing catalog section for the enabled skills. */
function renderCatalog(summaries: readonly EnabledSkillSummary[]): string {
  return [
    '## 可用技能',
    '以下技能与你的能力相关，可在需要时通过 `skill` 工具加载完整说明：',
    ...summaries.map(skill => `- \`${skill.name}\` — ${skill.description}`),
    '当任务与上述任一技能相关时，先调用 `skill` 工具（参数为技能名）获取完整指引，再开始执行。',
  ].join('\n')
}

/** Normalize an openUrl target: http(s)/file URL or local path → file:// URL. */
function resolveOpenUrlTarget(
  raw: string,
  workspaceDir: string | undefined,
): { ok: true; target: string; type: 'http' | 'file' } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: false, reason: 'url 参数不能为空' }

  if (/^https?:\/\//i.test(trimmed)) return { ok: true, target: trimmed, type: 'http' }

  if (/^file:\/\//i.test(trimmed)) {
    const filePath = decodeURIComponent(trimmed.replace(/^file:\/\//i, ''))
    if (!existsSync(filePath)) return { ok: false, reason: `文件不存在: ${filePath}` }
    return { ok: true, target: trimmed, type: 'file' }
  }

  // 本地路径：仅当以 /、盘符或 ~ 开头时视为路径，避免普通文本误判
  if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('~')) {
    const expanded = trimmed.startsWith('~') ? join(process.env.HOME ?? '', trimmed.slice(1)) : trimmed
    const resolvedPath = isAbsolute(expanded) ? expanded : resolve(workspaceDir ?? process.cwd(), expanded)
    if (!existsSync(resolvedPath)) return { ok: false, reason: `文件不存在: ${resolvedPath}` }
    return { ok: true, target: `file://${resolvedPath}`, type: 'file' }
  }

  return { ok: false, reason: '仅支持 http/https URL 或本地 HTML 文件路径' }
}

/** Scoped openUrl tool：校验目标后委托前端按 default_browser 设置打开。 */
function registerOpenUrlTool(agentCtx: Context, workspaceDir: string | undefined): void {
  agentCtx.tools.register(defineTool({
    name: 'openUrl',
    description: '打开指定的 URL 或本地 HTML 文件。支持 http/https 网址、file:// 本地文件、本地路径。会根据用户的浏览器设置使用应用内置浏览器或系统默认浏览器打开。',
    parameters: {
      url: { type: 'string', required: true, description: '要打开的 URL（http/https）或本地文件路径（如 /path/to/file.html 或 file:///path/to/file.html）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          type: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value as { type: string }).type === 'http'
          ? `正在打开: ${(value as { url: string }).url}`
          : `正在打开本地文件: ${(value as { url: string }).url}`,
      }],
    },
    async execute(args) {
      // 打开方式由前端根据 default_browser 设置分流（builtin/system）；
      // 后端负责校验与归一化，归一化结果随 output render 透出。
      const resolved = resolveOpenUrlTarget(args.url, workspaceDir)
      if (!resolved.ok) throw new Error(resolved.reason)
      return { url: resolved.target, type: resolved.type }
    },
  }))
}

/** Fetch 工具：单次响应体大小上限（字符数），超出截断并提示。 */
const FETCH_MAX_BODY_CHARS = 50_000

/** Fetch 工具：单次请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 15_000

/**
 * Scoped fetch tool：直接用 Node `fetch` 请求 HTTP(S) URL，返回状态码 +
 * 响应体文本。curl 对含中文或已 URL-encoded 参数的链接常常拿不到响应体
 * （例如 `?query=%E4%B8%8A%E6%B5%B7`），而原生 `fetch` 能正确请求并返回
 * 内容，故此工具用于替代「bash + curl 抓链接」的用法。
 */
function registerFetchTool(agentCtx: Context): void {
  agentCtx.tools.register(defineTool({
    name: 'fetch',
    description: '请求指定的 HTTP(S) URL 并返回响应内容（HTTP 状态码 + 响应体文本）。当需要获取某个链接或接口的返回内容时，优先使用本工具，而不要用 curl 或 bash 命令——curl 对含中文或已编码参数的 URL 可能拿不到响应体。',
    parameters: {
      url: { type: 'string', required: true, description: '要请求的 HTTP(S) URL' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          status: { type: 'integer' },
          contentType: { type: 'string' },
          body: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        const v = value as { url: string; status: number; contentType: string; body: string; truncated: boolean }
        const header = `Fetched ${v.url} (HTTP ${v.status}${v.contentType ? `, ${v.contentType}` : ''})\n\n`
        const footer = v.truncated ? '\n\n(响应体过长已截断，可请求更具体的 URL 获取完整内容)' : ''
        return [{ type: 'text', text: `${header}${v.body}${footer}` }]
      },
    },
    async execute(args, exec) {
      const raw = (args as { url: string }).url.trim()
      if (raw === '') throw new Error('url 参数不能为空')
      if (!/^https?:\/\//i.test(raw)) throw new Error('仅支持 http/https URL')
      const res = await fetch(raw, {
        signal: AbortSignal.any([exec.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        redirect: 'follow',
        headers: { 'user-agent': 'dsh-fetch-tool/1.0', 'accept': '*/*' },
      })
      const body = await res.text()
      const truncated = body.length > FETCH_MAX_BODY_CHARS
      return {
        url: res.url,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: truncated ? body.slice(0, FETCH_MAX_BODY_CHARS) : body,
        truncated,
      }
    },
  }))
}

/**
 * Build the agent setup callback for one bot. The returned callback is passed
 * straight to `ctx.agents.create/resume({ setup })`; it applies:
 *
 * 1. the persona prompt section;
 * 2. the long-term memory document (survives conversation clearing);
 * 3. the agent-disable triple guard when `agentEnabled` is off (no tool
 *    schemas, an explicit no-tools prompt, and a denying execution guard);
 * 4. the per-bot tool whitelist as a scoped `tools.restrict` (whitelisted-out
 *    tools disappear from the model-visible surface entirely);
 * 5. the enabled-skill catalog prompt section plus a scoped `skill` loader
 *    tool, mirroring the legacy chat-agent skill mechanism.
 */
export function buildBotAgentSetup(
  ctx: Context,
  bot: BotRecord,
  skillSummaries: readonly EnabledSkillSummary[],
  /** Long-term memory document; empty string registers no section. */
  memory = '',
): (agentCtx: Context) => void {
  const enabledTools = bot.enabledTools ?? []
  const allowedSkills = new Set(skillSummaries.map(skill => skill.name))
  const memoryText = memory.trim()

  return (agentCtx: Context): void => {
    agentCtx.systemPrompt.section({
      name: 'chat:persona',
      order: 0,
      text: bot.persona,
    })

    // 记忆段必须在 agentEnabled 的 early return 之前注册：
    // 未开启 Agent 能力的纯聊天好友同样需要长期记忆。
    if (memoryText !== '') {
      agentCtx.systemPrompt.section({
        name: 'chat:memory',
        order: 1,
        text: `【长期记忆】以下是你与这位用户长期相处沉淀下来的记忆，跨会话持续有效（清空对话不会丢失）。请自然地运用它，但不要生硬地复述或主动提及"我的记忆里写着"。\n\n${memoryText}`,
      })
    }

    const agentEnabled = bot.agentEnabled ?? bot.workspaceDir !== undefined
    if (!agentEnabled) {
      agentCtx.systemPrompt.suppressTools()
      agentCtx.systemPrompt.section({
        name: 'chat:no-tools',
        order: 1,
        text: '【重要】你没有任何可调用的工具或技能（包括读写文件、执行命令、搜索等）。请直接以纯文本对话回答，不要尝试调用任何工具。',
      })
      agentCtx.tools.guard(() => '该好友未开启 Agent 能力，无法调用工具或技能')
      return
    }

    // 工作区路径提示：会话工作区目录名含长 uuid，模型转写绝对路径时容易
    // 抄错（曾导致 glob 报 ENOENT）；引导其省略 path 或使用相对路径。
    agentCtx.systemPrompt.section({
      name: 'chat:workspace-hint',
      order: 1,
      text: '使用文件类工具（glob/grep/read/write 等）时，path 参数优先省略或使用相对路径——省略时默认就是你的会话工作区。不要手写工作区的长绝对路径（其中的目录名很长，极易抄错导致路径不存在）。',
    })

    // 用户上传图片提示：user 消息里直接附带的图片已经在消息中（inline base64），
    // 不在磁盘上任何可读路径里。read_image 只用于读取工作目录里已存在的图片，
    // 不要用 read_image 重复读取用户刚发过来的图片。
    agentCtx.systemPrompt.section({
      name: 'chat:image-attachment',
      order: 1,
      text: '【重要】用户消息里直接附带的图片已经在消息中以图片块呈现（inline base64），不在工作区任何已知路径下。不要调用 read_image 重复读取用户刚刚发来的图片——模型本轮就能直接看到该图片，没有磁盘路径可读。read_image 仅用于读取工作目录里已经存在的图片文件。',
    })

    // openUrl 工具（旧版 createOpenUrlTool 迁移）：校验/归一化在后端，
    // 打开方式由前端按 default_browser 设置分流（builtin/system）。
    registerOpenUrlTool(agentCtx, bot.workspaceDir)

    // fetch 工具：直接用 Node fetch 抓取链接内容。curl 对含中文/已编码
    // 参数的 URL 常拿不到响应体，故引导模型优先走 fetch 而非 bash+curl。
    registerFetchTool(agentCtx)
    agentCtx.systemPrompt.section({
      name: 'chat:fetch-preference',
      order: 1,
      text: '当需要获取某个链接/接口的返回内容时，优先调用 `fetch` 工具，而不是用 curl 或 bash 命令（curl 对含中文或已编码参数的 URL 可能拿不到响应体）。',
    })

    // read_document 工具：解析 docx/xlsx/pptx/pdf。这些是二进制格式，
    // 通用 `read` 工具会直接拒绝，模型若不知道有本工具就会束手无策
    // （甚至尝试自己解压 OOXML）。
    // 注册进 agentCtx（不受工具白名单限制），但文件读取走外层 ctx——
    // agentCtx 没有声明 fs 依赖，直接用它会抛 "cannot get property fs without inject"
    registerReadDocumentTool(agentCtx, ctx)
    agentCtx.systemPrompt.section({
      name: 'chat:document-preference',
      order: 1,
      text: '【重要】当用户提到或发来 .docx/.xlsx/.pptx/.pdf 文件时，必须调用 `read_document` 工具读取，不要用 `read`——`read` 只处理纯文本，遇到这些二进制格式会直接报错。也不要尝试用 bash 解压或用 python 自己解析它们。注意：旧版格式 .doc/.xls/.ppt 不支持，需要请用户另存为对应的 .docx/.xlsx/.pptx。',
    })

    // 工具白名单：restrict 过滤该 agent 继承的全局工具面（未列入的工具
    // schema 不会发给模型）；本层注册的 `skill` 工具不受影响。名单为空 =
    // 全部可用（旧版语义）。
    if (enabledTools.length > 0) {
      const known = new Set(ctx.tools.schemas().map(schema => schema.name))
      const allow = enabledTools.filter(name => known.has(name))
      if (allow.length > 0) agentCtx.tools.restrict({ allow })
    }

    // 技能：目录进提示词，正文经 scoped `skill` 工具按需加载（旧版
    // createSkillTool + formatSkillsForPrompt 语义）。
    if (skillSummaries.length > 0) {
      agentCtx.systemPrompt.section({
        name: 'chat:skills',
        order: 2,
        text: renderCatalog(skillSummaries),
      })
      agentCtx.tools.register(defineTool({
        name: 'skill',
        description: '加载指定技能的完整说明。当任务与可用技能列表中的技能相关时，先调用本工具获取完整指引。',
        parameters: {
          name: { type: 'string', required: true, description: '可用技能列表中的技能名' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              provider: { type: 'string' },
              content: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: renderSkillContent(value as { name: string; provider: string; content: string }),
          }],
        },
        async execute(args, exec) {
          const name = (args as { name: string }).name
          if (!isSkillName(name)) throw new Error(`invalid skill name "${name}"`)
          if (!allowedSkills.has(name)) throw new Error(`skill "${name}" 未在该好友的启用技能列表中`)
          const skill = await ctx.skills.get(name, {
            cwd: exec.agent?.session.header.cwd,
            signal: exec.signal,
            ...(exec.agent !== undefined ? { scope: exec.agent } : {}),
          })
          if (skill === undefined) throw new Error(`skill "${name}" 不存在或不可用`)
          return { name: skill.name, provider: skill.provider, content: skill.content }
        },
      }))
    }
  }
}
