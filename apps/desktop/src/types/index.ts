/** 与 CLI 侧 db/types.ts 对齐的 DTO */

export interface TriggerConfig {
  active_rate: number
  keywords: string[]
  cooldown_seconds: number
}

export type ModelProvider = 'openai' | 'anthropic' | 'mock'

export interface Bot {
  id: string
  name: string
  avatar: string | null
  persona: string
  skills: string[]
  trigger_config: TriggerConfig
  model_provider: ModelProvider
  model_name: string
  model_id: string | null
  // Agent 能力
  agent_enabled: number
  workspace_dir: string | null
  enabled_tools: string[]
  skill_dirs: string[]
  enabled_skills: string[]
  enabled_mcp_servers: string[]
  max_turns: number
  approval_policy: string
  created_at: number
  updated_at: number
  /** 群成员查询专用：好友已被删除时为 true（占位数据，仅用于灰显展示） */
  deleted?: boolean
}

export interface BotInput {
  name: string
  avatar?: string | null
  persona?: string
  skills?: string[]
  model_provider?: ModelProvider
  model_name?: string
  model_id?: string | null
  trigger_config?: Partial<TriggerConfig>
  // Agent 能力
  agent_enabled?: number
  workspace_dir?: string | null
  enabled_tools?: string[]
  skill_dirs?: string[]
  enabled_skills?: string[]
  enabled_mcp_servers?: string[]
  max_turns?: number
  approval_policy?: string
}

export type ConversationType = 'private' | 'group'

export interface Conversation {
  id: string
  type: ConversationType
  name: string
  avatar: string | null
  introduction: string
  last_message_preview: string | null
  last_message_at: number | null
  unread_count: number
  created_at: number
}

export interface UpdateConversationInput {
  name?: string
  introduction?: string
}

/** 消息内容段：思维链 / 正文 / 工具调用 交替，保持模型输出原始顺序 */
export interface MessageSegment {
  type: 'reasoning' | 'text' | 'tool'
  content: string
  /** 思维链耗时（毫秒），仅 reasoning 段有意义 */
  durationMs?: number
  /** tool 段：关联的工具调用 ID（对应 toolCalls 里的 id） */
  toolId?: string
}

export interface Message {
  id: string
  conversation_id: string
  sender_type: 'user' | 'ai_bot'
  sender_id: string
  sender_name: string
  content: string
  content_type: string
  is_self: number
  created_at: number
  /** CLI 附带：流式草稿 ID，用于把 toolCalls 精确迁移到该消息 */
  draftId?: string
  /** CLI 附带：该消息的工具调用（message.list 时返回，刷新后恢复展示） */
  tool_calls?: PersistedToolCall[]
  /** CLI 附带：有序内容段（reasoning/text），刷新后恢复思考过程展示 */
  segments?: MessageSegment[]
  /** 本次回复输入 token 数（0 表示未知） */
  prompt_tokens?: number
  /** 本次回复输出 token 数（0 表示未知） */
  completion_tokens?: number
  /** 本次回复输出总时长（毫秒） */
  duration_ms?: number
  /** 缓存命中的输入 token 数（0 表示未知/无缓存） */
  cached_tokens?: number
  /** 结束原因：'' 正常结束 | 'aborted' 用户主动终止 */
  stop_reason?: string
}

/** 工具调用（对齐 CLI PersistedToolCall） */
export interface PersistedToolCall {
  id: string
  name: string
  args?: unknown
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; details?: unknown }
  isError?: boolean
}

export interface ModelConfig {
  id: string
  name: string
  provider: string
  base_url: string
  api_key: string
  model_name: string
  tool_use: number
  image_input: number
  reasoning_mode: number
  custom_protocol: number
  input_ctx: string
  output_ctx: string
  created_at: number
  updated_at: number
}

export interface ModelInput {
  name: string
  provider?: string
  base_url?: string
  api_key?: string
  model_name?: string
  tool_use?: boolean
  image_input?: boolean
  reasoning_mode?: boolean
  custom_protocol?: boolean
  input_ctx?: string
  output_ctx?: string
}

export interface StreamFrame {
  messageId: string
  conversationId: string
  botId: string
  delta: string
  done: boolean
  reasoning?: boolean
}

export interface TypingFrame {
  conversationId: string
  botId: string
  botName: string
  typing: boolean
}
