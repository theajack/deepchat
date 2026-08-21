import { t } from '../i18n'
import { dshEvents, dshGet, dshRpc, dshSend } from './transport/dsh'

/** CLI 事件帧 */
export interface IpcEventFrame {
  event: string
  data: unknown
}

/**
 * IPC 传输层抽象（DIP）：上层只依赖此接口。
 * 迁移后实现为 DshTransport：经 HTTP/WS 与 `dsh --profile chat-agent`
 * 宿主进程通信（业务 CRUD 走 /chatapi/*，标准 RPC 走 /api/*）。
 */
export interface IpcTransport {
  request<T>(method: string, params?: Record<string, unknown>): Promise<T>
  onEvent(handler: (frame: IpcEventFrame) => void): () => void
}

// ── dsh 侧 DTO ───────────────────────────────────────────────────────────────

interface DshTrigger {
  activeRate: number
  keywords: string[]
  cooldownSeconds: number
}

interface DshBot {
  id: string
  name: string
  avatar?: string
  persona: string
  provider: string
  model: string
  trigger: DshTrigger
  sessionId: string
  createdAt: number
  updatedAt: number
}

interface DshGroup {
  id: string
  name: string
  avatar?: string
  memberBotIds: string[]
  sessionId: string
  createdAt: number
  updatedAt: number
}

interface DshMessageRow {
  seq: number
  time: number
  kind: 'user' | 'bot' | 'assistant'
  senderId: string
  senderName: string
  text: string
}

// ── 形状映射 ────────────────────────────────────────────────────────────────

type FrontBot = Record<string, unknown>
type FrontMessage = Record<string, unknown>
type FrontConversation = Record<string, unknown>

function toFrontTrigger(trigger: DshTrigger | undefined): { active_rate: number; keywords: string[]; cooldown_seconds: number } {
  return {
    active_rate: trigger?.activeRate ?? 0.3,
    keywords: trigger?.keywords ?? [],
    cooldown_seconds: trigger?.cooldownSeconds ?? 60,
  }
}

function fromFrontTrigger(trigger: Record<string, unknown> | undefined): DshTrigger | undefined {
  if (trigger === undefined) return undefined
  return {
    activeRate: Number(trigger.active_rate ?? 0.3),
    keywords: Array.isArray(trigger.keywords) ? trigger.keywords.map(String) : [],
    cooldownSeconds: Number(trigger.cooldown_seconds ?? 60),
  }
}

function toFrontBot(bot: DshBot): FrontBot {
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar ?? null,
    persona: bot.persona,
    skills: [],
    trigger_config: toFrontTrigger(bot.trigger),
    model_provider: bot.provider,
    model_name: bot.model,
    model_id: null,
    agent_enabled: 0,
    workspace_dir: null,
    enabled_tools: [],
    skill_dirs: [],
    enabled_skills: [],
    enabled_mcp_servers: [],
    max_turns: 0,
    approval_policy: '',
    created_at: bot.createdAt,
    updated_at: bot.updatedAt,
  }
}

function fromFrontBotInput(input: Record<string, unknown>): Record<string, unknown> {
  return {
    name: String(input.name ?? ''),
    avatar: input.avatar == null ? undefined : String(input.avatar),
    persona: input.persona == null ? '' : String(input.persona),
    provider: input.model_provider == null ? undefined : String(input.model_provider),
    model: input.model_name == null ? undefined : String(input.model_name),
    trigger: fromFrontTrigger(input.trigger_config as Record<string, unknown> | undefined),
  }
}

function privateConversationId(botId: string): string {
  return `private:${botId}`
}

function botIdOfPrivate(conversationId: string): string {
  return conversationId.slice('private:'.length)
}

function toFrontMessage(row: DshMessageRow, conversationId: string): FrontMessage {
  const isSelf = row.kind === 'user'
  return {
    id: `${conversationId}:${String(row.seq)}`,
    conversation_id: conversationId,
    sender_type: isSelf ? 'user' : 'ai_bot',
    sender_id: row.senderId,
    sender_name: row.senderName,
    content: row.text,
    content_type: 'text',
    is_self: isSelf ? 1 : 0,
    created_at: row.time,
  }
}

// ── 传输实现 ────────────────────────────────────────────────────────────────

const NOT_MIGRATED = '该功能尚未迁移到 dsh 底座'

export class DshTransport implements IpcTransport {
  requestTimeoutMs = 30000

  /** 本地设置桥（M1：暂存 localStorage，后续迁至 dsh settings/credentials） */
  private localSettings(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem('chat-agent:settings') ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }

  private setLocalSetting(key: string, value: string): void {
    const all = this.localSettings()
    all[key] = value
    localStorage.setItem('chat-agent:settings', JSON.stringify(all))
  }

  private async requestInner<T>(method: string, params: Record<string, unknown>): Promise<T> {
    // ── bot CRUD ──
    if (method === 'bot.list') {
      const { items } = await dshGet<{ items: DshBot[] }>('/chatapi/bots')
      return items.map(toFrontBot) as T
    }
    if (method === 'bot.create') {
      const bot = await dshSend<DshBot>('POST', '/chatapi/bots', fromFrontBotInput(params))
      return toFrontBot(bot) as T
    }
    if (method === 'bot.update') {
      const { id, ...rest } = params
      const bot = await dshSend<DshBot>('PUT', `/chatapi/bots/${String(id)}`, fromFrontBotInput({ ...rest, name: rest.name ?? ' unnamed' }))
      return toFrontBot(bot) as T
    }
    if (method === 'bot.delete') {
      await dshSend('DELETE', `/chatapi/bots/${String(params.id)}`)
      return undefined as T
    }

    // ── conversation（私聊 = bot 会话；群聊 = /chatapi/groups）──
    if (method === 'conversation.list') {
      const [bots, groups] = await Promise.all([
        dshGet<{ items: DshBot[] }>('/chatapi/bots'),
        dshGet<{ items: DshGroup[] }>('/chatapi/groups'),
      ])
      const privates: FrontConversation[] = bots.items.map(bot => ({
        id: privateConversationId(bot.id),
        type: 'private',
        name: bot.name,
        avatar: bot.avatar ?? null,
        introduction: '',
        last_message_preview: null,
        last_message_at: bot.updatedAt,
        unread_count: 0,
        created_at: bot.createdAt,
      }))
      const groupList: FrontConversation[] = groups.items.map(group => ({
        id: group.id,
        type: 'group',
        name: group.name,
        avatar: group.avatar ?? null,
        introduction: '',
        last_message_preview: null,
        last_message_at: group.updatedAt,
        unread_count: 0,
        created_at: group.createdAt,
      }))
      return [...groupList, ...privates] as T
    }
    if (method === 'conversation.createPrivate') {
      const { items } = await dshGet<{ items: DshBot[] }>('/chatapi/bots')
      const bot = items.find(b => b.id === params.botId)
      if (bot === undefined) throw new Error('bot not found')
      return {
        id: privateConversationId(bot.id),
        type: 'private',
        name: bot.name,
        avatar: bot.avatar ?? null,
        introduction: '',
        last_message_preview: null,
        last_message_at: bot.updatedAt,
        unread_count: 0,
        created_at: bot.createdAt,
      } as T
    }
    if (method === 'conversation.createGroup') {
      const group = await dshSend<DshGroup>('POST', '/chatapi/groups', {
        name: params.name,
        memberBotIds: params.botIds,
      })
      return {
        id: group.id,
        type: 'group',
        name: group.name,
        avatar: group.avatar ?? null,
        introduction: '',
        last_message_preview: null,
        last_message_at: group.createdAt,
        unread_count: 0,
        created_at: group.createdAt,
      } as T
    }
    if (method === 'conversation.members') {
      const group = await dshGet<DshGroup>(`/chatapi/groups/${String(params.id)}`)
      const { items } = await dshGet<{ items: DshBot[] }>('/chatapi/bots')
      return items.filter(b => group.memberBotIds.includes(b.id)).map(toFrontBot) as T
    }
    if (method === 'conversation.addMember' || method === 'conversation.removeMember') {
      const id = String(params.id)
      const group = await dshGet<DshGroup>(`/chatapi/groups/${id}`)
      const botId = String(params.botId)
      const members = method === 'conversation.addMember'
        ? [...new Set([...group.memberBotIds, botId])]
        : group.memberBotIds.filter(m => m !== botId)
      await dshSend('PUT', `/chatapi/groups/${id}`, { memberBotIds: members })
      return undefined as T
    }
    if (method === 'conversation.update') {
      const { id, ...patch } = params
      const group = await dshSend<DshGroup>('PUT', `/chatapi/groups/${String(id)}`, patch)
      return {
        id: group.id,
        type: 'group',
        name: group.name,
        avatar: group.avatar ?? null,
        introduction: '',
        last_message_preview: null,
        last_message_at: group.updatedAt,
        unread_count: 0,
        created_at: group.createdAt,
      } as T
    }
    if (method === 'conversation.markRead') return undefined as T
    if (method === 'conversation.delete') {
      const id = String(params.id)
      if (!id.startsWith('private:')) await dshSend('DELETE', `/chatapi/groups/${id}`)
      return undefined as T
    }

    // ── message ──
    if (method === 'message.list') {
      const conversationId = String(params.conversationId)
      if (conversationId.startsWith('private:')) {
        const botId = botIdOfPrivate(conversationId)
        const { items } = await dshGet<{ items: DshMessageRow[] }>(`/chatapi/bots/${botId}/history`)
        return items.map(row => toFrontMessage(row, conversationId)) as T
      }
      const { items } = await dshGet<{ items: DshMessageRow[] }>(`/chatapi/groups/${conversationId}/history`)
      return items.map(row => toFrontMessage(row, conversationId)) as T
    }
    if (method === 'message.send') {
      const conversationId = String(params.conversationId)
      const content = String(params.content)
      if (conversationId.startsWith('private:')) {
        await dshSend('POST', `/chatapi/bots/${botIdOfPrivate(conversationId)}/send`, { content })
      } else {
        await dshSend('POST', `/chatapi/groups/${conversationId}/send`, { content, senderName: 'me' })
      }
      return {
        id: crypto.randomUUID(),
        conversation_id: conversationId,
        sender_type: 'user',
        sender_id: 'me',
        sender_name: 'me',
        content,
        content_type: 'text',
        is_self: 1,
        created_at: Date.now(),
      } as T
    }
    if (method === 'message.stop') {
      // TODO(M5): 映射到标准 RPC session.cancel
      return { ok: true, stopped: false } as T
    }
    if (method === 'message.clear') {
      // TODO(M2): 群容器会话重建
      return undefined as T
    }

    // ── settings（M1 本地桥，M2 迁 dsh settings/credentials）──
    if (method === 'settings.get') return (this.localSettings()[String(params.key)] ?? null) as T
    if (method === 'settings.set') {
      this.setLocalSetting(String(params.key), String(params.value))
      return undefined as T
    }
    if (method === 'settings.all') return this.localSettings() as T
    if (method === 'settings.defaultWorkspaceDir') return '' as T

    // ── model：M2 起映射 /api/llm.providers + credentials ──
    if (method === 'model.list') {
      const providers = await dshRpc<Array<Record<string, unknown>>>('llm.providers')
      return (providers ?? []).flatMap((provider) => {
        const models = Array.isArray(provider.models) ? provider.models as Array<Record<string, unknown>> : []
        return models.map(model => ({
          id: `${String(provider.id)}:${String(model.id ?? '')}`,
          name: String(model.id ?? ''),
          provider: String(provider.id),
          base_url: '',
          api_key: '',
          model_name: String(model.id ?? ''),
          tool_use: 1,
          image_input: 0,
          reasoning_mode: 0,
          custom_protocol: 0,
          input_ctx: '',
          output_ctx: '',
          created_at: 0,
          updated_at: 0,
        }))
      }) as T
    }

    // ── 工具：dsh 全局工具注册表投影 ──
    if (method === 'tool.listAll') {
      const { items } = await dshGet<{ items: Array<{ name: string; label: string; description: string; source: string; available: boolean }> }>('/chatapi/tools')
      return items as T
    }
    if (method === 'tool.openUrl' || method === 'tool.openDir') {
      // TODO(M5): open_url 走 chat-tools 插件 remote-event；目录打开走 plugin-opener
      throw new Error(NOT_MIGRATED)
    }

    // ── 技能：dsh skill 注册表（bundled + $DSH_HOME/skills + project）──
    if (method === 'skill.list') {
      return await dshGet<T>('/chatapi/skills')
    }
    if (method === 'skill.create') {
      return await dshSend<T>('POST', '/chatapi/skills', {
        name: params.name,
        description: params.description,
      })
    }
    if (method === 'skill.delete') {
      return await dshSend<T>('DELETE', `/chatapi/skills/${encodeURIComponent(String(params.name))}`)
    }
    if (method === 'skill.installLocal') {
      return await dshSend<T>('POST', '/chatapi/skills/install-local', {
        srcDir: params.srcDir,
        skillFilter: params.skillFilter,
      })
    }
    if (method === 'skill.find' || method === 'skill.installGithub') {
      // TODO(M4): GitHub 技能搜索/安装（skills.sh catalog）
      throw new Error(NOT_MIGRATED)
    }

    // ── persona 生成：M4（chat-persona-gen 插件）──
    if (method === 'persona.generate' || method === 'persona.generateSelfIntro') {
      throw new Error(NOT_MIGRATED)
    }
    if (method.startsWith('model.')) throw new Error(NOT_MIGRATED)
    if (method.startsWith('mcp.')) throw new Error(NOT_MIGRATED)

    throw new Error(`${t('ipc.timeout', { ms: 0, method })}: unknown method ${method}`)
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(t('ipc.timeout', { ms: this.requestTimeoutMs, method }))), this.requestTimeoutMs)
    })
    return await Promise.race([this.requestInner<T>(method, params), timeout])
  }

  onEvent(handler: (frame: IpcEventFrame) => void): () => void {
    return dshEvents((frame) => {
      // mux 帧 → 旧事件形状的最小翻译；未识别的帧按原样透传（stores 自行忽略）
      if (frame.type === 'session/projection') {
        handler({ event: 'dsh.session.projection', data: frame })
        return
      }
      handler({ event: `dsh.${frame.type}`, data: frame })
    })
  }
}

export const transport: IpcTransport = new DshTransport()
