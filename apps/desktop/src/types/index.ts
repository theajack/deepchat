/** 与 CLI 侧 db/types.ts 对齐的 DTO */

export interface TriggerConfig {
  /** 是否允许在群里主动发言；false = 仅被 @ 或回应他人时发言 */
  auto_speak: boolean
  /** 群聊安静多少分钟后该成员主动开口（仅 auto_speak 开启时生效） */
  idle_trigger_minutes: number
}

export type ModelProvider = 'openai' | 'anthropic' | 'mock'

export interface Bot {
  id: string
  name: string
  avatar: string | null
  persona: string
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
  /** 群聊共享工作目录（仅群聊有值）；创建后不可修改 */
  workspace_dir?: string | null
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

/** 消息附件（图片 / 文件 / 文档）。本地发送带 dataUrl 即时展示；历史消息由后端返回 url/ref */
export interface MessageAttachment {
  kind: 'image' | 'file' | 'document'
  name: string
  mediaType: string
  size: number
  /** 本地发送时的预览 data URL（历史消息缺失，改用 url） */
  dataUrl?: string
  /** 图片的可访问 URL（历史消息由后端拼好 base URL） */
  url?: string
  /** 已落盘附件的工作区相对路径：文件类点击时用系统默认程序打开 */
  ref?: string
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
  /**
   * 发送回执携带：本次用户消息在 session 内占用的 promptSeq（仅私聊）。
   * 前端据此把 loading 占位气泡放到这条消息之后——页面内计数在长会话
   * 分页时算不准，必须以服务端为准。
   */
  promptSeq?: number
  /** 消息附件（图片 / 文件），发送时附带，历史消息由后端投影 */
  attachments?: MessageAttachment[]
  /** 后端游标（会话事件 seq），历史向上翻页时作为 before 参数 */
  seq?: number
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
  route_id: string
  tool_use: boolean
  image_input: boolean
  reasoning_mode: boolean
  custom_protocol: boolean
  input_ctx: string
  output_ctx: string
  created_at: number
  updated_at: number
}

/** 一个好友的长期记忆文档（跨会话持久，清空对话不丢失） */
export interface BotMemory {
  text: string
  /** 上次沉淀时间（epoch ms）；null 表示尚无记忆 */
  updatedAt: number | null
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
  /** 该 stream 对应的 user message 序号（与 session 内 promptSeqOf 一致），
   *  用于实时把 draft 紧跟到对应用户消息下方。 */
  promptSeq?: number
}

export interface TypingFrame {
  conversationId: string
  botId: string
  botName: string
  typing: boolean
}
