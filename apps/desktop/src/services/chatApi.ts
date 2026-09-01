import type { Bot, BotInput, BotMemory, Conversation, Message, MessageAttachment, ModelConfig, ModelInput, UpdateConversationInput } from '../types'
import { transport, type IpcTransport } from './ipc'
import { dshFetch } from './transport/dsh'

/** 一页历史消息 + 是否还有更早的记录 */
export interface MessagePage {
  items: Message[]
  hasMore: boolean
}

/** 群聊级设置（不属于单个群，对所有群聊生效） */
export interface GroupSettings {
  /** 是否启用发言调度者：由调度模型判断轮到谁发言，以及是否该保持安静 */
  schedulerEnabled: boolean
}

/**
 * 通用处理模型的显式设置与实际生效值。
 *
 * 通用处理模型负责「生成人设 / 自我介绍 / 群聊介绍」这类编辑辅助调用，
 * 与 AI 好友聊天所用的默认模型相互独立，可单独指定为更便宜或更快的模型。
 */
export interface GeneralModel {
  /** 显式设置的模型 id，空串表示未设置 */
  id: string
  /** 经回落链后真正生效的模型 id，空串表示无任何可用模型 */
  effectiveId: string
}

/** 一天的用量 */
export interface DailyUsage {
  date: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
}

/** 单个模型的累计用量 + 最近若干天的每日明细 */
export interface ModelUsage {
  modelId: string
  modelName: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  requests: number
  daily: DailyUsage[]
}

/**
 * Token 用量报表。
 *
 * 与后端 `TokenUsageReport` 结构一致（前端刻意不 import 后端包，两端独立演进，
 * 只是字段对齐）。`days` 是最近 7 天的日期，`daily` 为所有模型按天合计。
 */
export interface TokenUsageReport {
  days: string[]
  models: ModelUsage[]
  grandTotal: Omit<DailyUsage, 'date'>
  daily: DailyUsage[]
}

/** 上传成功的文档（路径相对好友工作区，供 read_document 读取） */
export interface UploadedFile {
  path: string
  name: string
  size: number
}

/** 人设/介绍生成的种类，决定后端选用哪套提示词 */
export type PersonaKind = 'botPersona' | 'selfIntro' | 'groupIntro'

/** 一次人设/介绍生成请求的入参 */
export interface PersonaInput {
  /** 主体名称：好友名 / 我的昵称 / 群名 */
  name: string
  /** 用户已填的片段，作为基底润色而非丢弃 */
  partial?: string
  /** 群成员显示名，仅生成群聊介绍时使用 */
  memberNames?: string[]
  /** 显式指定模型 id；省略时后端回落到通用处理模型 */
  model_id?: string | null
}

/** 类型化业务 API 门面：stores 只依赖它，不直接感知传输层（SRP + DIP） */
export class ChatApi {
  constructor(private t: IpcTransport) {}

  listBots(): Promise<Bot[]> {
    return this.t.request('bot.list')
  }
  createBot(input: BotInput): Promise<Bot> {
    return this.t.request('bot.create', input as unknown as Record<string, unknown>)
  }
  updateBot(id: string, patch: Partial<BotInput>): Promise<Bot> {
    return this.t.request('bot.update', { id, ...patch } as Record<string, unknown>)
  }
  deleteBot(id: string): Promise<void> {
    return this.t.request('bot.delete', { id })
  }

  listModels(): Promise<ModelConfig[]> {
    return this.t.request('model.list')
  }
  createModel(input: ModelInput): Promise<ModelConfig> {
    return this.t.request('model.create', input as unknown as Record<string, unknown>)
  }
  updateModel(id: string, patch: Partial<ModelInput>): Promise<ModelConfig> {
    return this.t.request('model.update', { id, ...patch } as Record<string, unknown>)
  }
  deleteModel(id: string): Promise<void> {
    return this.t.request('model.delete', { id })
  }
  setDefaultModel(id: string | null): Promise<void> {
    return this.t.request('model.setDefault', { id })
  }
  /**
   * Set (or clear, with null) the general-purpose model used for editor
   * assists such as persona and introduction generation.
   */
  setGeneralModel(id: string | null): Promise<void> {
    return this.t.request('model.setGeneral', { id })
  }
  /**
   * Read the general-purpose model: `id` is what the user explicitly picked,
   * `effectiveId` is what actually runs after the fallback chain
   * (general → default chat model → first model).
   */
  getGeneralModel(): Promise<GeneralModel> {
    return this.t.request('model.getGeneral')
  }

  /** Read the aggregated token-usage report (per model + 7-day trend). */
  getTokenUsage(): Promise<TokenUsageReport> {
    return this.t.request('tokenUsage.report')
  }

  /**
   * Upload a binary document into a bot's workspace.
   * @returns path relative to that workspace, for `read_document` to consume.
   */
  uploadFile(botId: string, name: string, base64: string): Promise<UploadedFile> {
    return this.t.request('file.upload', { botId, name, data: base64 })
  }

  /** Read the group-chat-wide settings. */
  getGroupSettings(): Promise<GroupSettings> {
    return this.t.request('group.getSettings')
  }
  /** Toggle the speaker scheduler on/off. */
  setGroupSchedulerEnabled(enabled: boolean): Promise<GroupSettings> {
    return this.t.request('group.setSchedulerEnabled', { schedulerEnabled: enabled })
  }

  /** Read one bot's long-term memory document (survives clearing the chat). */
  getBotMemory(id: string): Promise<BotMemory> {
    return this.t.request('bot.getMemory', { id })
  }
  /** Overwrite one bot's long-term memory document. */
  setBotMemory(id: string, text: string): Promise<BotMemory> {
    return this.t.request('bot.setMemory', { id, text })
  }

  listConversations(): Promise<Conversation[]> {
    return this.t.request('conversation.list')
  }
  createPrivateConversation(botId: string): Promise<Conversation> {
    return this.t.request('conversation.createPrivate', { botId })
  }
  createGroupConversation(
    name: string,
    botIds: string[],
    introduction = '',
    /** 群聊共享工作目录；留空由后端分配默认目录 */
    workspaceDir?: string,
  ): Promise<Conversation> {
    return this.t.request('conversation.createGroup', { name, botIds, introduction, workspaceDir })
  }
  listGroupMembers(conversationId: string): Promise<Bot[]> {
    return this.t.request('conversation.members', { id: conversationId })
  }
  addGroupMember(conversationId: string, botId: string): Promise<void> {
    return this.t.request('conversation.addMember', { id: conversationId, botId })
  }
  removeGroupMember(conversationId: string, botId: string): Promise<void> {
    return this.t.request('conversation.removeMember', { id: conversationId, botId })
  }
  updateConversation(id: string, patch: UpdateConversationInput): Promise<Conversation> {
    return this.t.request('conversation.update', { id, ...patch })
  }
  markConversationRead(id: string): Promise<void> {
    return this.t.request('conversation.markRead', { id })
  }
  deleteConversation(id: string): Promise<void> {
    return this.t.request('conversation.delete', { id })
  }

  /** 拉取一页历史消息（游标分页）：before 为已加载最早一行的 seq，省略则取最新一页 */
  listMessages(conversationId: string, before?: number, limit = 50): Promise<MessagePage> {
    return this.t.request('message.list', { conversationId, before, limit })
  }
  sendMessage(
    conversationId: string,
    content: string,
    images?: Array<{ mediaType: string; data: string; name?: string; size?: number }>,
    attachments?: MessageAttachment[],
  ): Promise<Message> {
    return this.t.request('message.send', {
      conversationId,
      content,
      ...(images && images.length > 0 ? { images } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    })
  }
  stopMessage(conversationId: string, botId?: string): Promise<{ ok: boolean; stopped: boolean }> {
    return this.t.request('message.stop', { conversationId, botId })
  }
  clearMessages(conversationId: string): Promise<void> {
    return this.t.request('message.clear', { conversationId })
  }

  getSetting(key: string): Promise<string | null> {
    return this.t.request('settings.get', { key })
  }
  setSetting(key: string, value: string): Promise<void> {
    return this.t.request('settings.set', { key, value })
  }
  allSettings(): Promise<Record<string, string>> {
    return this.t.request('settings.all')
  }
  /** 调试面板「本地日志」：同步/查询宿主侧日志开关（含日志文件路径）。 */
  debugLog(enabled?: boolean): Promise<{ enabled: boolean; path: string }> {
    return this.t.request('settings.debugLog', ...(enabled === undefined ? [] : [{ enabled }]))
  }
  /** 读取宿主侧调试日志尾部（面板预览）。 */
  debugLogTail(lines?: number): Promise<{ tail: string; path: string }> {
    return this.t.request('settings.debugLogTail', ...(lines === undefined ? [] : [{ lines }]))
  }
  getDefaultWorkspaceDir(): Promise<string> {
    return this.t.request('settings.defaultWorkspaceDir')
  }
  /** 设置页「数据目录」：dsh home 下真实存在的存储位置清单。 */
  dataDirs(): Promise<{ root: string; dirs: Array<{ name: string; path: string }> }> {
    return this.t.request('settings.dataDirs')
  }

  /**
   * Stream one generated text back delta by delta.
   *
   * Persona generation is inherently a stream (the field fills in as the model
   * writes), so it talks to the host's SSE endpoint directly instead of going
   * through the request/response envelope in {@link IpcTransport}.
   *
   * Always runs on the general-purpose model unless `model_id` pins another.
   */
  private async streamPersona(
    body: Record<string, unknown>,
    onDelta: (delta: string) => void,
  ): Promise<{ content: string }> {
    // 必须走 dshFetch（Tauri 内用 plugin-http）而不是原生 fetch：
    // WebView 自身的 CORS 策略会拒绝从 asset:// / dev server 跨源请求
    // http://127.0.0.1:3180，表现为 WKWebView 的 "Load failed" —— 而
    // `http:default` 能力只授权 plugin-http，管不到原生 fetch。
    const res = await dshFetch('/chatapi/persona/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(detail === '' ? `生成失败 (HTTP ${String(res.status)})` : detail)
    }

    let content = ''
    /** Parse one SSE payload and fold it into the running result. */
    const consume = (payload: string): void => {
      if (payload === '') return
      const frame = JSON.parse(payload) as { delta?: string; done?: boolean; content?: string; error?: string }
      if (typeof frame.error === 'string') throw new Error(frame.error)
      if (typeof frame.delta === 'string') onDelta(frame.delta)
      else if (frame.done === true) content = frame.content ?? ''
    }

    // 流式优先：逐块读取，字段随模型输出实时填充。
    if (res.body !== null && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        // SSE 帧以 \n\n 结尾；兼容 \r\n\r\n 换行（服务端实际输出 \r\n\r\n）
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          consume(raw.replace(/^data: /, '').trim())
        }
      }
      return { content }
    }

    // 兜底：拿不到流（plugin-http 缓冲了整个响应）时一次性解析，
    // 牺牲实时填充，但保证功能可用而不是报错。
    const text = await res.text()
    for (const chunk of text.split('\n\n')) consume(chunk.replace(/^data: /, '').trim())
    return { content }
  }

  /** 生成 AI 好友人设（使用通用处理模型） */
  generatePersona(input: PersonaInput, onDelta: (delta: string) => void): Promise<{ content: string }> {
    return this.streamPersona({ ...input, kind: 'botPersona' }, onDelta)
  }

  /** 生成我的自我介绍（使用通用处理模型） */
  generateSelfIntro(input: PersonaInput, onDelta: (delta: string) => void): Promise<{ content: string }> {
    return this.streamPersona({ ...input, kind: 'selfIntro' }, onDelta)
  }

  /** 生成群聊介绍（使用通用处理模型） */
  generateGroupIntro(input: PersonaInput, onDelta: (delta: string) => void): Promise<{ content: string }> {
    return this.streamPersona({ ...input, kind: 'groupIntro' }, onDelta)
  }
}

export const chatApi = new ChatApi(transport)
