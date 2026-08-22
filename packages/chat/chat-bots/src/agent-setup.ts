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

/**
 * Build the agent setup callback for one bot. The returned callback is passed
 * straight to `ctx.agents.create/resume({ setup })`; it applies:
 *
 * 1. the persona prompt section;
 * 2. the agent-disable triple guard when `agentEnabled` is off (no tool
 *    schemas, an explicit no-tools prompt, and a denying execution guard);
 * 3. the per-bot tool whitelist as a scoped `tools.restrict` (whitelisted-out
 *    tools disappear from the model-visible surface entirely);
 * 4. the enabled-skill catalog prompt section plus a scoped `skill` loader
 *    tool, mirroring the legacy chat-agent skill mechanism.
 */
export function buildBotAgentSetup(
  ctx: Context,
  bot: BotRecord,
  skillSummaries: readonly EnabledSkillSummary[],
): (agentCtx: Context) => void {
  const enabledTools = bot.enabledTools ?? []
  const allowedSkills = new Set(skillSummaries.map(skill => skill.name))

  return (agentCtx: Context): void => {
    agentCtx.systemPrompt.section({
      name: 'chat:persona',
      order: 0,
      text: bot.persona,
    })

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

    // openUrl 工具（旧版 createOpenUrlTool 迁移）：校验/归一化在后端，
    // 打开方式由前端按 default_browser 设置分流（builtin/system）。
    registerOpenUrlTool(agentCtx, bot.workspaceDir)

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
