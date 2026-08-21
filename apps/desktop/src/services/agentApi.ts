import { transport } from './ipc'

// ---- 与 CLI runtime 方法 1:1 对应的类型契约 ----

export interface ToolInfo {
  name: string
  description: string
  source: 'builtin' | 'skill' | 'mcp'
  server?: string
}

export interface ToolMeta {
  name: string
  label: string
  description: string
  source: string
  available: boolean
  server?: string
}

export interface SkillInfo {
  name: string
  description: string
  location: string
  path: string
  body: string
  source?: string
  disableModelInvocation: boolean
  internal: boolean
  builtin?: boolean
}

export interface SkillListResult {
  skills: SkillInfo[]
  diagnostics: { location?: string; message: string }[]
}

export interface SkillSearchResult {
  name: string
  slug: string
  source: string
  installs: number
  installsLabel: string
  installCommand: string
  url: string
}

export interface SkillFindResult {
  skills: SkillSearchResult[]
}

export interface SkillCreateResult {
  skillDir: string
  location: string
  content: string
}

export interface SkillDeleteResult {
  deleted: boolean
  path: string
}

export interface SkillInstallResult {
  installed: string[]
  skipped: string[]
}

export interface McpServerInfo {
  id: string
  name: string
  transport: string
  enabled: boolean
  builtin?: boolean
  health: 'disconnected' | 'connecting' | 'connected' | 'error'
  toolCount: number
  error?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: unknown
}

export type ApprovalDecision = 'allow' | 'deny' | 'always_allow'

// ---- LLM 调用追踪（调试面板「对话信息」） ----

export interface LlmTraceMessage {
  role: string
  content: string
}

export interface LlmTraceEntry {
  id: string
  ts: number
  provider: string
  model: string
  kind: 'chat' | 'stream'
  conversationId?: string
  botId?: string
  botName?: string
  system: string
  input: LlmTraceMessage[]
  output: string
  reasoning: string
  toolCalls: { name: string; args?: unknown }[]
  usage: { promptTokens?: number; completionTokens?: number }
  error?: string
}

export const toolList = (botId: string) => transport.request<ToolInfo[]>('tool.list', { botId })
export const toolListAll = () => transport.request<ToolMeta[]>('tool.listAll', {})
export const toolOpenUrl = (url: string) => transport.request<{ ok: boolean; url: string }>('tool.openUrl', { url })
export const toolOpenDir = (dir: string) => transport.request<{ ok: boolean; dir: string }>('tool.openDir', { dir })
export const skillList = (workspaceDir?: string, skillDirs?: string[]) =>
  transport.request<SkillListResult>('skill.list', { workspaceDir, skillDirs })
export const skillFind = (query: string, owner?: string) =>
  transport.request<SkillFindResult>('skill.find', { query, owner })
export const skillCreate = (workspaceDir: string | undefined, name: string, description: string) =>
  transport.request<SkillCreateResult>('skill.create', { workspaceDir, name, description })
export const skillDelete = (name: string, workspaceDir?: string) =>
  transport.request<SkillDeleteResult>('skill.delete', { name, workspaceDir })
export const skillInstallLocal = (srcDir: string, workspaceDir?: string, skillFilter?: string[]) =>
  transport.request<SkillInstallResult>('skill.installLocal', { srcDir, workspaceDir, skillFilter })
export const skillInstallGithub = (source: string, workspaceDir?: string) =>
  transport.request<SkillInstallResult>('skill.installGithub', { source, workspaceDir })
export const mcpList = () => transport.request<McpServerInfo[]>('mcp.list', {})
export const mcpAdd = (p: Record<string, unknown>) => transport.request('mcp.add', p)
export const mcpUpdate = (id: string, p: Record<string, unknown>) => transport.request('mcp.update', { id, ...p })
export const mcpRemove = (id: string) => transport.request('mcp.remove', { id })
export const mcpTest = (id: string) => transport.request('mcp.test', { id })
export const mcpTools = (id: string) => transport.request<McpToolInfo[]>('mcp.tools', { id })
export const approvalRespond = (requestId: string, decision: ApprovalDecision) =>
  transport.request('approval.respond', { requestId, decision })
export const llmTraceList = () => transport.request<LlmTraceEntry[]>('llm.trace.list', {})
export const llmTraceClear = () => transport.request<{ ok: boolean }>('llm.trace.clear', {})

/** 统一 API 对象，组件通过 import { agentApi } 访问。 */
export const agentApi = {
  toolList,
  toolListAll,
  toolOpenUrl,
  toolOpenDir,
  skillList,
  skillFind,
  skillCreate,
  skillDelete,
  skillInstallLocal,
  skillInstallGithub,
  mcpList,
  mcpAdd,
  mcpUpdate,
  mcpRemove,
  mcpTest,
  mcpTools,
  approvalRespond,
  llmTraceList,
  llmTraceClear,
}
