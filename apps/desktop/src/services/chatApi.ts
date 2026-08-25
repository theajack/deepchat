import type { Bot, BotInput, Conversation, Message, ModelConfig, ModelInput, UpdateConversationInput } from '../types'
import { transport, type IpcTransport } from './ipc'

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

  listConversations(): Promise<Conversation[]> {
    return this.t.request('conversation.list')
  }
  createPrivateConversation(botId: string): Promise<Conversation> {
    return this.t.request('conversation.createPrivate', { botId })
  }
  createGroupConversation(name: string, botIds: string[], introduction = ''): Promise<Conversation> {
    return this.t.request('conversation.createGroup', { name, botIds, introduction })
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

  listMessages(conversationId: string, before?: number, limit = 50): Promise<Message[]> {
    return this.t.request('message.list', { conversationId, before, limit })
  }
  sendMessage(conversationId: string, content: string): Promise<Message> {
    return this.t.request('message.send', { conversationId, content })
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

  generatePersona(
    input: { name: string; partial?: string; model_provider?: string; model_name?: string; model_id?: string | null },
    onDelta: (delta: string) => void,
  ): Promise<{ content: string }> {
    const requestId = crypto.randomUUID()
    let off: (() => void) | undefined
    return new Promise((resolve, reject) => {
      import('./ipc').then(({ transport }) => {
        off = transport.onEvent((frame) => {
          if (frame.event !== 'persona.stream') return
          const data = frame.data as { requestId: string; delta: string; done: boolean; error?: string }
          if (data.requestId !== requestId) return
          if (data.error) {
            off?.()
            reject(new Error(data.error))
            return
          }
          if (data.done) {
            off?.()
            return
          }
          onDelta(data.delta)
        })
      })
      this.t
        .request<{ content: string }>('persona.generate', { ...input, requestId })
        .then(resolve, reject)
    })
  }

  /** 生成自我介绍（复用 persona.stream 事件流） */
  generateSelfIntro(
    input: { name: string; partial?: string; model_provider?: string; model_name?: string; model_id?: string | null },
    onDelta: (delta: string) => void,
  ): Promise<{ content: string }> {
    const requestId = crypto.randomUUID()
    let off: (() => void) | undefined
    return new Promise((resolve, reject) => {
      import('./ipc').then(({ transport }) => {
        off = transport.onEvent((frame) => {
          if (frame.event !== 'persona.stream') return
          const data = frame.data as { requestId: string; delta: string; done: boolean; error?: string }
          if (data.requestId !== requestId) return
          if (data.error) {
            off?.()
            reject(new Error(data.error))
            return
          }
          if (data.done) {
            off?.()
            return
          }
          onDelta(data.delta)
        })
      })
      this.t
        .request<{ content: string }>('persona.generateSelfIntro', { ...input, requestId })
        .then(resolve, reject)
    })
  }
}

export const chatApi = new ChatApi(transport)
