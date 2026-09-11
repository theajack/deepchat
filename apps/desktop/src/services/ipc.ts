import { t } from '../i18n'
import type { TriggerConfig } from '../types'
import { convertFileSrc } from '@tauri-apps/api/core'
import { dshBaseUrl, dshChatEvents, dshEvents, dshGet, dshSend } from './transport/dsh'

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
  /** 群聊空闲多久后主动开口（分钟）；仅 autoSpeak 为 true 时生效 */
  idleTriggerMinutes?: number
  /** 未设置 = 不主动发言（缺省为 false，主动发言是显式选择） */
  autoSpeak?: boolean
  [key: string]: unknown
}

interface DshBot {
  id: string
  name: string
  avatar?: string
  persona: string
  provider: string
  model: string
  modelId?: string | null
  agentEnabled?: number
  introduction?: string | null
  workspaceDir?: string | null
  enabledTools?: string[]
  enabledSkills?: string[]
  enabledMcpServers?: string[]
  deletedAt?: number | null
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
  /** 群聊共享工作目录（后端创建时分配或用户指定） */
  workspaceDir?: string
  /** 自主对话疲劳阈值（未设置时后端按 5 处理） */
  aiFatigueRounds?: number
  /** @某成员时其他成员是否也可回复（缺省 false） */
  mentionOthersReply?: boolean
  createdAt: number
  updatedAt: number
}

interface DshToolCallRow {
  id: string
  name: string
  args?: unknown
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean }
  isError?: boolean
}

interface DshMessageRow {
  id?: string
  /** 持久游标：历史分页的 before 依据 */
  seq?: number
  time: number
  kind: 'user' | 'bot' | 'assistant'
  senderId: string
  senderName: string
  text: string
  segments?: Array<{ type: 'reasoning' | 'text' | 'tool'; content: string; toolId?: string }>
  toolCalls?: DshToolCallRow[]
  /** 该消息携带的附件元信息（图片引用 / 文件相对路径） */
  attachments?: Array<{
    kind?: string
    name?: string
    mediaType?: string
    size?: number
    ref?: string
  }>
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
  durationMs?: number
  stopReason?: string
}

// ── 形状映射 ────────────────────────────────────────────────────────────────

type FrontBot = Record<string, unknown>
type FrontMessage = Record<string, unknown>
type FrontConversation = Record<string, unknown>

/** 把后端 avatar 字段（可能是 /chatapi/avatars/:id.ext 相对路径）补成 webview 可访问的完整 URL */
function toFrontAvatarUrl(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  if (/^(data:|https?:|blob:|\/)/.test(raw)) {
    // /chatapi/avatars/* 需要拼 base URL；其他已经是绝对 / dataURL / blob
    if (raw.startsWith('/chatapi/avatars/')) return dshBaseUrl() + raw
    return raw
  }
  return raw
}

function toFrontTrigger(trigger: DshTrigger | undefined): TriggerConfig {
  return {
    // 严格 === true：缺失一律视为关闭，主动发言是显式选择。
    auto_speak: trigger?.autoSpeak === true,
    // 7 与后端兜底值一致（5–10 区间的中位）；有配置时以配置为准。
    idle_trigger_minutes: trigger?.idleTriggerMinutes ?? 7,
  }
}

function fromFrontTrigger(trigger: Record<string, unknown> | undefined): DshTrigger | undefined {
  if (trigger === undefined) return undefined
  const minutes = Number(trigger.idle_trigger_minutes)
  return {
    // 概率与关键词已不再由界面暴露，但后端结构仍要求它们存在，保留默认值。
    // 冷却归零：它会掐断成员之间的一来一回（说完一轮就集体静音），
    // 而界面上已经没有入口让用户调它了。
    activeRate: 0.3,
    keywords: [],
    cooldownSeconds: 0,
    autoSpeak: trigger.auto_speak === true,
    ...(Number.isFinite(minutes) && minutes > 0 ? { idleTriggerMinutes: minutes } : {}),
  }
}

function toFrontBot(bot: DshBot): FrontBot {
  return {
    id: bot.id,
    name: bot.name,
    avatar: toFrontAvatarUrl(bot.avatar),
    persona: bot.persona,
    trigger_config: toFrontTrigger(bot.trigger),
    model_provider: bot.provider,
    model_name: bot.model,
    model_id: bot.modelId ?? null,
    agent_enabled: bot.agentEnabled ?? 0,
    workspace_dir: bot.workspaceDir ?? null,
    enabled_tools: bot.enabledTools ?? [],
    skill_dirs: [],
    enabled_skills: bot.enabledSkills ?? [],
    enabled_mcp_servers: bot.enabledMcpServers ?? [],
    max_turns: 0,
    approval_policy: '',
    created_at: bot.createdAt,
    updated_at: bot.updatedAt,
  }
}

function fromFrontBotInput(input: Record<string, unknown>): Record<string, unknown> {
  const toArray = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.map(String) : undefined
  const enabledTools = toArray(input.enabled_tools)
  const enabledSkills = toArray(input.enabled_skills)
  const enabledMcpServers = toArray(input.enabled_mcp_servers)
  // 本地图片头像 dataURL（区别于 dicebear 字符串 URL —— 后者以 http/data:image-dicebear? 开头，
  // data:image/png;base64 是本地选择上传；后端会自动判断并写入 workspace/agents/<botId>/）
  const avatarRaw = input.avatar == null ? undefined : String(input.avatar)
  const isDataUrl = typeof avatarRaw === 'string' && avatarRaw.startsWith('data:image/')
  // 工作目录：留空沿用后端默认（workspace/agents/<botId>），填写则以用户
  // 指定目录为准（后端会创建它，并作为该好友文件操作与记忆的沙箱根目录）。
  const workspaceDirRaw = input.workspace_dir
  const workspaceDir =
    typeof workspaceDirRaw === 'string' && workspaceDirRaw.trim() !== ''
      ? workspaceDirRaw.trim()
      : undefined
  return {
    name: String(input.name ?? ''),
    ...(isDataUrl ? { avatarData: avatarRaw } : { avatar: avatarRaw }),
    persona: input.persona == null ? '' : String(input.persona),
    introduction: input.introduction == null ? undefined : String(input.introduction),
    agentEnabled: Number(input.agent_enabled ?? 0) === 1,
    provider: input.model_provider == null ? undefined : String(input.model_provider),
    model: input.model_name == null ? undefined : String(input.model_name),
    // 模型唯一 ID：好友绑定的是这条模型记录本身，而不是端点/模型名快照
    modelId: input.model_id == null || input.model_id === '' ? undefined : String(input.model_id),
    trigger: fromFrontTrigger(input.trigger_config as Record<string, unknown> | undefined),
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
    ...(enabledTools !== undefined ? { enabledTools } : {}),
    ...(enabledSkills !== undefined ? { enabledSkills } : {}),
    ...(enabledMcpServers !== undefined ? { enabledMcpServers } : {}),
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
    id: row.id ?? `${conversationId}:${String(row.seq ?? row.time)}`,
    conversation_id: conversationId,
    seq: row.seq,
    sender_type: isSelf ? 'user' : 'ai_bot',
    sender_id: row.senderId,
    sender_name: row.senderName,
    content: row.text,
    content_type: 'text',
    is_self: isSelf ? 1 : 0,
    created_at: row.time,
    segments: row.segments,
    tool_calls: row.toolCalls?.map(call => ({
      id: call.id,
      name: call.name,
      args: call.args,
      result: call.result,
      isError: call.isError ?? call.result?.isError ?? false,
    })),
    prompt_tokens: row.promptTokens ?? 0,
    completion_tokens: row.completionTokens ?? 0,
    cached_tokens: row.cachedTokens ?? 0,
    duration_ms: row.durationMs ?? 0,
    stop_reason: row.stopReason ?? '',
    // 历史消息也带附件：元信息来自 session，字节由 HTTP 端点按需取回
    ...(Array.isArray(row.attachments) && row.attachments.length > 0
      ? { attachments: row.attachments.map(toFrontAttachment) }
      : {}),
  }
}

/**
 * 把后端附件元信息映射成前端形状，并把图片引用补全成可访问的 URL。
 *
 * 历史图片的 `ref` 有三种形态：
 * - 新发送的：磁盘绝对路径（`/Users/...`），用 Tauri 的 convertFileSrc 转成
 *   `asset://localhost/...`，让 webview 走本地文件协议，避开自身跨源
 *   CORS（`http://127.0.0.1:3180` 的 <img> 在 WKWebView 里被拒）
 * - 旧的相对路径：`/chatapi/images/...`，由 dsh HTTP 服务
 * - 最老的：`att-<id>`，attachment store id，需走 `/chatapi/attachments/:id`
 *
 * 文件的 `ref` 是工作区相对路径，前端拿不到绝对路径，交给后端解析。
 */
function toFrontAttachment(raw: {
  kind?: string
  name?: string
  mediaType?: string
  size?: number
  ref?: string
}): Record<string, unknown> {
  const kind = raw.kind === 'image' ? 'image' : 'document'
  const name = String(raw.name ?? 'attachment')
  const ref = String(raw.ref ?? '')
  let url = ''
  if (kind === 'image') {
    if (ref.startsWith('/')) {
      // 两种可能：磁盘绝对路径 或 后端 HTTP 相对路径。
      // 后者的 ref 由 send 端点生成，形如 /chatapi/images/<convId>/<file>
      // （带空格以外的路径），与真实磁盘路径（如 /Users/...）有可区分的差异：
      // 磁盘路径一定在 HOME 下，不会含 /chatapi/。
      if (ref.includes('/chatapi/')) {
        url = `${dshBaseUrl()}${ref}`
      } else {
        // 磁盘绝对路径：交给 Tauri 转换。assetProtocol scope = ["**"]，
        // 所以 $HOME 下任何文件都能被 webview 加载。
        url = convertToAssetUrl(ref)
      }
    } else if (ref !== '') {
      // 最老的 attachment store id
      url = `${dshBaseUrl()}/chatapi/attachments/${encodeURIComponent(ref)}`
    }
  }
  return {
    kind,
    name,
    mediaType: String(raw.mediaType ?? 'application/octet-stream'),
    size: Number(raw.size ?? 0),
    ref,
    url,
  }
}

/**
 * 把磁盘绝对路径转换成 Tauri webview 可加载的 asset:// URL。
 *
 * `tauri.conf.json` 已启用 assetProtocol 且 scope 为 ["**"]，因此 $HOME
 * 下任何文件都能被 webview 直接加载，避开跨源 CORS。
 *
 * 纯浏览器开发（不在 Tauri 内）时 convertFileSrc 会抛错（window.__TAURI__
 * 不存在），此时回退为 file:// 走浏览器原生能力。
 */
function convertToAssetUrl(absPath: string): string {
  try {
    return convertFileSrc(absPath)
  } catch {
    return `file://${absPath}`
  }
}

// ── 传输实现 ────────────────────────────────────────────────────────────────

const NOT_MIGRATED = '该功能尚未迁移到 dsh 底座'

export class DshTransport implements IpcTransport {
  requestTimeoutMs = 30000

  /** Guards the one-shot default-model migration below. */
  private defaultModelMigrated = false

  /** 本地设置桥（M1：暂存 localStorage，后续迁至 dsh settings/credentials） */
  private localSettings(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem('deepchat:settings') ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  }

  /**
   * Read the general-purpose model (explicit pick + effective model) from the
   * host. Backed by the same preference the group scheduler uses.
   */
  private async fetchGeneralModel(): Promise<{ id: string; effectiveId: string }> {
    try {
      const res = await dshGet<{ id: string | null; effectiveId: string | null }>('/chatapi/models/group-judge')
      return { id: res.id ?? '', effectiveId: res.effectiveId ?? '' }
    } catch {
      return { id: '', effectiveId: '' }
    }
  }

  /**
   * One-shot migration: the default model used to live only in localStorage,
   * which the host cannot read. Push it once so background work (memory
   * consolidation) resolves the same model the UI shows.
   */
  private async migrateDefaultModel(): Promise<void> {
    if (this.defaultModelMigrated) return
    this.defaultModelMigrated = true
    const local = this.localSettings()['default_model_id']
    if (local === undefined || local === '') return
    try {
      const current = await dshGet<{ id: string | null }>('/chatapi/models/default')
      if (current.id === null) await dshSend('POST', '/chatapi/models/default', { id: local })
    } catch {
      // 静默：仅后台任务失去偏好，UI 行为不受影响
    }
  }

  /** Push the default-model choice to the host; fire-and-forget, never blocks the UI. */
  private async syncDefaultModel(id: string): Promise<void> {
    try {
      await dshSend('POST', '/chatapi/models/default', { id })
    } catch {
      // 后端不可用时静默：默认模型本身已存本地，仅后台任务失去偏好
    }
  }

  private setLocalSetting(key: string, value: string): void {
    const all = this.localSettings()
    all[key] = value
    localStorage.setItem('deepchat:settings', JSON.stringify(all))
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
    if (method === 'bot.clone') {
      // 服务端会同步完成"会话总结 → 写入克隆体记忆"，因此这一步较慢，
      // 前端需要给出等待反馈（见 ContactsView 的克隆按钮）。
      const bot = await dshSend<DshBot>('POST', `/chatapi/bots/${String(params.id)}/clone`, {
        // 克隆词由前端按当前语言提供；后端据此生成「名字-克隆体N」
        ...(typeof params.suffix === 'string' ? { suffix: params.suffix } : {}),
      })
      return toFrontBot(bot) as T
    }

    // ── conversation（私聊 = bot 会话；群聊 = /chatapi/groups）──
    if (method === 'conversation.list') {
      const [bots, groups, previews, groupPreviews] = await Promise.all([
        dshGet<{ items: DshBot[] }>('/chatapi/bots'),
        dshGet<{ items: DshGroup[] }>('/chatapi/groups'),
        dshSend<{ previews: Record<string, { preview: string; at: number }> }>('POST', '/chatapi/misc', { action: 'conversation-previews' }).catch(() => ({ previews: {} })),
        dshSend<{ previews: Record<string, { preview: string; at: number }> }>('POST', '/chatapi/group-misc', { action: 'conversation-previews' }).catch(() => ({ previews: {} })),
      ])
      const mergedPreviews = { ...previews.previews, ...groupPreviews.previews }
      const previewOf = (id: string): { preview: string | null; at: number | null } => {
        const hit = mergedPreviews[id]
        return hit === undefined ? { preview: null, at: null } : { preview: hit.preview, at: hit.at }
      }
      const privates: FrontConversation[] = bots.items.map((bot) => {
        const hit = previewOf(privateConversationId(bot.id))
        return {
          id: privateConversationId(bot.id),
          type: 'private',
          name: bot.name,
          avatar: toFrontAvatarUrl(bot.avatar),
          introduction: bot.introduction ?? '',
          last_message_preview: hit.preview,
          last_message_at: hit.at ?? bot.updatedAt,
          unread_count: 0,
          created_at: bot.createdAt,
        }
      })
      const groupList: FrontConversation[] = groups.items.map((group) => {
        const hit = previewOf(group.id)
        return {
          id: group.id,
          type: 'group',
          name: group.name,
          avatar: group.avatar ?? null,
          introduction: '',
          last_message_preview: hit.preview,
          last_message_at: hit.at ?? group.updatedAt,
          unread_count: 0,
          created_at: group.createdAt,
          workspace_dir: group.workspaceDir ?? null,
          ai_fatigue_rounds: group.aiFatigueRounds ?? null,
          mention_others_reply: group.mentionOthersReply ?? null,
        }
      })
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
        avatar: toFrontAvatarUrl(bot.avatar),
        introduction: '',
        last_message_preview: null,
        last_message_at: bot.updatedAt,
        unread_count: 0,
        created_at: bot.createdAt,
      } as T
    }
    if (method === 'conversation.createGroup') {
      // 群聊共享工作目录：留空则由后端分配默认目录
      const groupWorkspaceDir = typeof params.workspaceDir === 'string' && params.workspaceDir.trim() !== ''
        ? params.workspaceDir.trim()
        : undefined
      const group = await dshSend<DshGroup>('POST', '/chatapi/groups', {
        name: params.name,
        memberBotIds: params.botIds,
        ...(groupWorkspaceDir !== undefined ? { workspaceDir: groupWorkspaceDir } : {}),
        ...(typeof params.aiFatigueRounds === 'number' ? { aiFatigueRounds: params.aiFatigueRounds } : {}),
        ...(typeof params.mentionOthersReply === 'boolean' ? { mentionOthersReply: params.mentionOthersReply } : {}),
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
        workspace_dir: group.workspaceDir ?? null,
        ai_fatigue_rounds: group.aiFatigueRounds ?? null,
        mention_others_reply: group.mentionOthersReply ?? null,
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
        workspace_dir: group.workspaceDir ?? null,
        ai_fatigue_rounds: group.aiFatigueRounds ?? null,
        mention_others_reply: group.mentionOthersReply ?? null,
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
      // 游标分页：before = 已加载最早一行的 seq，limit = 页大小
      const before = typeof params.before === 'number' ? params.before : undefined
      const limit = typeof params.limit === 'number' ? params.limit : undefined
      const query = [
        ...(before !== undefined ? [`before=${String(before)}`] : []),
        ...(limit !== undefined ? [`limit=${String(limit)}`] : []),
      ].join('&')
      const suffix = query === '' ? '' : `?${query}`
      if (conversationId.startsWith('private:')) {
        const botId = botIdOfPrivate(conversationId)
        const page = await dshGet<{ items: DshMessageRow[]; hasMore?: boolean }>(`/chatapi/bots/${botId}/history${suffix}`)
        return { items: page.items.map(row => toFrontMessage(row, conversationId)), hasMore: page.hasMore ?? false } as T
      }
      const page = await dshGet<{ items: DshMessageRow[]; hasMore?: boolean }>(`/chatapi/groups/${conversationId}/history${suffix}`)
      return { items: page.items.map(row => toFrontMessage(row, conversationId)), hasMore: page.hasMore ?? false } as T
    }
    if (method === 'message.send') {
      const conversationId = String(params.conversationId)
      const content = String(params.content ?? '')
      const images = Array.isArray(params.images)
        ? (params.images as Array<{ mediaType: string; data: string; name?: string; size?: number }>)
        : []
      // 文件/文档附件：字节已在发送前上传到工作区，这里只需把元信息交给后端
      // 落进 session，刷新后历史接口就能原样返回、气泡照常渲染。
      const attachments = Array.isArray(params.attachments) ? params.attachments : []
      const fileAttachments = attachments
        .filter((a): a is Record<string, unknown> =>
          a !== null && typeof a === 'object' && typeof (a as { ref?: unknown }).ref === 'string')
        .map(a => ({
          kind: String((a as { kind?: unknown }).kind ?? 'document'),
          name: String((a as { name?: unknown }).name ?? 'attachment'),
          mediaType: String((a as { mediaType?: unknown }).mediaType ?? 'application/octet-stream'),
          size: Number((a as { size?: unknown }).size ?? 0),
          ref: String((a as { ref?: unknown }).ref),
        }))
      // 私聊：后端回本次消息将占用的 promptSeq，用于给 loading 占位气泡定位。
      // 群聊走调度模型、回复由 bot.typing 驱动，没有 m-p{N} 概念，故为 undefined。
      let promptSeq: number | undefined
      if (conversationId.startsWith('private:')) {
        const ack = await dshSend<{ accepted?: boolean; promptSeq?: unknown }>(
          'POST', `/chatapi/bots/${botIdOfPrivate(conversationId)}/send`, {
            content,
            ...(images.length > 0 ? { images } : {}),
            ...(fileAttachments.length > 0 ? { attachments: fileAttachments } : {}),
          })
        if (ack !== null && typeof ack === 'object' && typeof ack.promptSeq === 'number') {
          promptSeq = ack.promptSeq
        }
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
        // 本地即时展示：图片沿用内联 dataUrl，文件沿用已上传的相对路径。
        // 刷新后改由历史接口返回同样的元信息，因此气泡里看到的是同一套附件。
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(promptSeq !== undefined ? { promptSeq } : {}),
      } as T
    }
    if (method === 'message.stop') {
      const conversationId = String(params.conversationId ?? '')
      if (conversationId.startsWith('private:')) {
        // 私聊：终止该好友 agent 的当前生成 turn
        return await dshSend<T>('POST', `/chatapi/bots/${conversationId.slice('private:'.length)}/stop`)
      }
      if (conversationId.startsWith('group:')) {
        // 群聊：终止容器编排 + 全部成员 bot agent
        return await dshSend<T>('POST', `/chatapi/groups/${conversationId.slice('group:'.length)}/stop`)
      }
      return { ok: true, stopped: false } as T
    }
    if (method === 'message.clear') {
      const conversationId = String(params.conversationId ?? '')
      if (conversationId.startsWith('private:')) {
        await dshSend('POST', `/chatapi/bots/${encodeURIComponent(conversationId.slice('private:'.length))}/clear`)
      } else {
        await dshSend('POST', `/chatapi/groups/${encodeURIComponent(conversationId)}/clear`)
      }
      return undefined as T
    }

    // ── settings（M1 本地桥，M2 迁 dsh settings/credentials）──
    if (method === 'settings.get') return (this.localSettings()[String(params.key)] ?? null) as T
    if (method === 'settings.set') {
      const key = String(params.key)
      const value = String(params.value)
      this.setLocalSetting(key, value)
      // 本地调试日志开关实时同步到 dsh 宿主（老方案 configureDebugLog 迁移）
      if (key === 'debug_log_enabled') {
        try {
          await dshSend('POST', '/chatapi/misc', { action: 'debug-log', enabled: value === 'true' })
        } catch { /* 宿主未就绪时忽略，下次设置再同步 */ }
      }
      return undefined as T
    }
    if (method === 'settings.all') return this.localSettings() as T
    if (method === 'settings.defaultWorkspaceDir') return '' as T

    // ── model：/chatapi/models（storage 记录 + llm-pi-ai 路由同步）──
    if (method === 'model.list') {
      const { items } = await dshGet<{ items: Array<Record<string, unknown>> }>('/chatapi/models')
      void this.migrateDefaultModel()
      return items as T
    }
    if (method === 'model.create') {
      const created = await dshSend<T>('POST', '/chatapi/models', params)
      // 无默认模型时，新增模型自动设为默认
      const record = created as Record<string, unknown> | undefined
      const currentDefault = this.localSettings()['default_model_id']
      if (record !== null && typeof record === 'object' && record.id !== undefined && (currentDefault === undefined || currentDefault === '')) {
        this.setLocalSetting('default_model_id', String(record.id))
      }
      return created as T
    }
    if (method === 'model.update') {
      const { id, ...rest } = params
      return await dshSend<T>('PUT', `/chatapi/models/${encodeURIComponent(String(id))}`, rest)
    }
    if (method === 'model.delete') {
      await dshSend('DELETE', `/chatapi/models/${encodeURIComponent(String(params.id))}`)
      // 删除的是默认模型时，将第一个模型设为默认（无剩余模型则清空）
      if (this.localSettings()['default_model_id'] === String(params.id ?? '')) {
        const { items } = await dshGet<{ items: Array<{ id: string }> }>('/chatapi/models')
        const next = items.find(m => m.id !== String(params.id ?? ''))
        this.setLocalSetting('default_model_id', next?.id ?? '')
      }
      return undefined as T
    }
    if (method === 'model.setDefault') {
      const id = String(params.id ?? '')
      this.setLocalSetting('default_model_id', id)
      // 同步到宿主：记忆沉淀等后台任务在后端解析默认模型，读不到 localStorage
      void this.syncDefaultModel(id)
      return undefined as T
    }
    if (method === 'model.setGeneral') {
      // 通用处理模型只在后端生效，不同步 localStorage
      const raw = params.id
      const id = raw === null || raw === undefined ? '' : String(raw)
      await dshSend('POST', '/chatapi/models/group-judge', { id })
      return undefined as T
    }
    if (method === 'model.getGeneral') return await this.fetchGeneralModel() as T
    if (method === 'tokenUsage.report') {
      return await dshGet<T>('/chatapi/token-usage')
    }
    if (method === 'file.upload') {
      return await dshSend<T>('POST', '/chatapi/misc', {
        action: 'upload-file',
        botId: String(params.botId ?? ''),
        name: String(params.name ?? ''),
        data: String(params.data ?? ''),
      })
    }
    if (method === 'file.open') {
      // 用系统默认程序打开好友工作区内的文件：路径解析必须在服务端做，
      // 前端只知道工作区相对路径，也没有文件系统的访问权
      return await dshSend<T>('POST', '/chatapi/misc', {
        action: 'open-file',
        botId: String(params.botId ?? ''),
        path: String(params.path ?? ''),
      })
    }
    if (method === 'group.getSettings') {
      return await dshGet<T>('/chatapi/group-settings')
    }
    if (method === 'group.setSchedulerEnabled') {
      const schedulerEnabled = params.schedulerEnabled === true
      return await dshSend<T>('PUT', '/chatapi/group-settings', { schedulerEnabled })
    }
    if (method === 'bot.getMemory') {
      return await dshGet<T>(`/chatapi/bots/${encodeURIComponent(String(params.id))}/memory`)
    }
    if (method === 'bot.setMemory') {
      return await dshSend<T>('PUT', `/chatapi/bots/${encodeURIComponent(String(params.id))}/memory`, { text: String(params.text ?? '') })
    }

    // ── 工具：dsh 全局工具注册表投影 ──
    if (method === 'tool.listAll') {
      const { items } = await dshGet<{ items: Array<{ name: string; label: string; description: string; source: string; available: boolean }> }>('/chatapi/tools')
      return items as T
    }
    if (method === 'tool.openDir') {
      return await dshSend<T>('POST', '/chatapi/misc', { action: 'open-dir', dir: params.dir })
    }
    if (method === 'tool.openUrl') {
      // 与 openDir 同一系统命令路径（open/explorer/xdg-open）
      return await dshSend<T>('POST', '/chatapi/misc', { action: 'open-dir', dir: params.url ?? params.dir })
    }
    if (method === 'settings.defaultWorkspaceDir' || method === 'chat.getDefaultWorkspaceDir') {
      const { dir } = await dshSend<{ dir: string }>('POST', '/chatapi/misc', { action: 'default-workspace-dir' })
      return dir as T
    }
    if (method === 'settings.dataDirs') {
      return await dshSend<T>('POST', '/chatapi/misc', { action: 'data-dirs' })
    }
    if (method === 'settings.debugLog') {
      return await dshSend<T>('POST', '/chatapi/misc', {
        action: 'debug-log',
        ...(typeof params.enabled === 'boolean' ? { enabled: params.enabled } : {}),
      })
    }
    if (method === 'settings.debugLogTail') {
      return await dshSend<T>('POST', '/chatapi/misc', {
        action: 'debug-log-tail',
        ...(typeof params.lines === 'number' ? { lines: params.lines } : {}),
      })
    }
    if (method === 'misc.pickDir') {
      // 打开系统原生目录选择对话框。这纯粹是桌面端能力，不涉及 dsh 宿主，
      // 因此不走 transport 而是直接调 Tauri 插件。
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: true,
        multiple: false,
        ...(typeof params.defaultPath === 'string' && params.defaultPath !== ''
          ? { defaultPath: params.defaultPath }
          : {}),
      })
      // 用户取消时为 null；单选模式下返回值是 string
      return (typeof selected === 'string' ? selected : null) as T
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
    if (method === 'skill.find') {
      const owner = typeof params.owner === 'string' && params.owner.trim() !== '' ? params.owner.trim() : undefined
      return await dshSend<T>('POST', '/chatapi/skills/find', {
        query: params.query,
        ...(owner !== undefined ? { owner } : {}),
      })
    }
    if (method === 'skill.installGithub') {
      return await dshSend<T>('POST', '/chatapi/skills/install-github', {
        source: params.source,
      })
    }

    // ── LLM trace（调试面板「对话信息」）──
    if (method === 'llm.trace.list') {
      return await dshSend<T>('GET', '/chatapi/llm-trace')
    }
    if (method === 'llm.trace.clear') {
      return await dshSend<T>('DELETE', '/chatapi/llm-trace')
    }

    // ── MCP 服务管理（/chatapi/mcp）──
    if (method === 'mcp.list') {
      // 端点返回 { items: [...] }，这里解包成数组再给上层
      const r = await dshSend<{ items: T }>('GET', '/chatapi/mcp')
      return (r ?? { items: [] as T }).items
    }
    if (method === 'mcp.add') {
      return await dshSend<T>('POST', '/chatapi/mcp/-', params)
    }
    if (method === 'mcp.update') {
      return await dshSend<T>('PUT', `/chatapi/mcp/${encodeURIComponent(String(params.id))}`, params)
    }
    if (method === 'mcp.remove') {
      return await dshSend<T>('DELETE', `/chatapi/mcp/${encodeURIComponent(String(params.id))}`)
    }
    if (method === 'mcp.test') {
      return await dshSend<T>('POST', `/chatapi/mcp/${encodeURIComponent(String(params.id))}/test`)
    }
    if (method === 'mcp.tools') {
      const r = await dshSend<{ tools: Array<{ name: string; description?: string }> }>('POST', `/chatapi/mcp/${encodeURIComponent(String(params.id))}/test`)
      return r.tools as T
    }

    // persona 生成走 chatApi 的 SSE 流式接口（POST /chatapi/persona/generate），
    // 不经过这里的请求/响应信封 —— 它需要逐 delta 回调而非一次性结果。
    if (method.startsWith('model.')) throw new Error(NOT_MIGRATED)

    throw new Error(`${t('ipc.timeout', { ms: 0, method })}: unknown method ${method}`)
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(t('ipc.timeout', { ms: this.requestTimeoutMs, method }))), this.requestTimeoutMs)
    })
    return await Promise.race([this.requestInner<T>(method, params), timeout])
  }

  onEvent(handler: (frame: IpcEventFrame) => void): () => void {
    // chat 业务事件（SSE，legacy 事件形状）直接透传给 stores
    const stopChat = dshChatEvents(frame => handler(frame))
    // dsh mux 帧按原样透传（stores 自行忽略未识别帧）
    const stopMux = dshEvents((frame) => {
      if (frame.type === 'session/projection') {
        handler({ event: 'dsh.session.projection', data: frame })
        return
      }
      handler({ event: `dsh.${frame.type}`, data: frame })
    })
    return () => {
      stopChat()
      stopMux()
    }
  }
}

export const transport: IpcTransport = new DshTransport()
