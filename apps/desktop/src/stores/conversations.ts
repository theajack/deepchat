import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { chatApi } from '../services/chatApi'
import type { Bot, Conversation, UpdateConversationInput } from '../types'
import { useBotsStore } from './bots'

/** 会话列表模块 */
export const useConversationsStore = defineStore('conversations', () => {
  const items = ref<Conversation[]>([])
  const activeId = ref<string | null>(null)
  /** 因「当前在聊天」而被加入会话列表的会话 id（即便暂无消息也不移除） */
  const pinned = ref<string[]>([])
  /** 置顶会话 id（持久化到 localStorage） */
  const PINNED_TOP_KEY = 'chat-agent:pinned-top'
  function loadPinnedTop(): string[] {
    try {
      const v = JSON.parse(localStorage.getItem(PINNED_TOP_KEY) ?? '[]')
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const pinnedTop = ref<string[]>(loadPinnedTop())
  function persistPinnedTop() {
    try {
      localStorage.setItem(PINNED_TOP_KEY, JSON.stringify(pinnedTop.value))
    } catch {
      /* 忽略 */
    }
  }
  /** 群聊成员缓存（conversationId -> 成员列表），详情页按会话 id 读取 */
  const membersMap = ref<Record<string, Bot[]>>({})

  const active = computed(() => items.value.find(c => c.id === activeId.value) ?? null)
  const totalUnread = computed(() => items.value.reduce((sum, c) => sum + c.unread_count, 0))

  /** 消息列表可见项：包含有消息记录的，或曾因聊天被打开（pinned）的会话；置顶会话排在最前 */
  const chatList = computed(() => {
    const visible = items.value.filter(c => c.last_message_at != null || pinned.value.includes(c.id))
    return [...visible].sort(
      (a, b) => Number(pinnedTop.value.includes(b.id)) - Number(pinnedTop.value.includes(a.id)),
    )
  })

  function pin(id: string) {
    if (!pinned.value.includes(id)) pinned.value = [...pinned.value, id]
  }

  function isPinnedTop(id: string) {
    return pinnedTop.value.includes(id)
  }

  function togglePinTop(id: string) {
    pinnedTop.value = isPinnedTop(id)
      ? pinnedTop.value.filter(x => x !== id)
      : [...pinnedTop.value, id]
    persistPinnedTop()
  }

  function sortItems() {
    items.value = [...items.value].sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at))
  }

  async function load() {
    items.value = await chatApi.listConversations()
    sortItems()
    if (!activeId.value && items.value.length > 0) {
      await select(items.value[0].id)
    }
  }

  /** 选中会话：标记已读并加载消息（消息加载委托给 messages store，由调用方串联） */
  async function select(id: string) {
    activeId.value = id
    pin(id)
    const conv = items.value.find(c => c.id === id)
    // 预加载群聊成员，保证 @ 提及与详情页能实时拿到成员列表
    if (conv?.type === 'group') void loadMembers(id)
    if (conv && conv.unread_count > 0) {
      conv.unread_count = 0
      void chatApi.markConversationRead(id)
    }
    const { useMessagesStore } = await import('./messages')
    // 清理脏草稿：避免上一次 done 事件丢失导致的残留气泡
    useMessagesStore().cleanupDrafts(id)
    await useMessagesStore().load(id)
  }

  async function createPrivate(botId: string): Promise<Conversation> {
    const conv = await chatApi.createPrivateConversation(botId)
    upsert(conv)
    return conv
  }

  async function createGroup(name: string, botIds: string[], introduction = ''): Promise<Conversation> {
    const conv = await chatApi.createGroupConversation(name, botIds, introduction)
    upsert(conv)
    return conv
  }

  /** 加载群聊成员并写入本地缓存（详情页读取 membersMap[id]） */
  async function loadMembers(conversationId: string): Promise<Bot[]> {
    const members = await chatApi.listGroupMembers(conversationId)
    membersMap.value = { ...membersMap.value, [conversationId]: members }
    return members
  }

  async function addMember(conversationId: string, botId: string) {
    await chatApi.addGroupMember(conversationId, botId)
    const cur = membersMap.value[conversationId] ?? []
    if (cur.some(b => b.id === botId)) return
    const bot = useBotsStore().items.find(b => b.id === botId)
    if (bot) membersMap.value = { ...membersMap.value, [conversationId]: [...cur, bot] }
  }

  async function removeMember(conversationId: string, botId: string) {
    await chatApi.removeGroupMember(conversationId, botId)
    const cur = membersMap.value[conversationId] ?? []
    membersMap.value = { ...membersMap.value, [conversationId]: cur.filter(b => b.id !== botId) }
  }

  async function updateGroup(id: string, patch: UpdateConversationInput) {
    const updated = await chatApi.updateConversation(id, patch)
    upsert(updated)
  }

  /** 清空会话消息记录（后端删除 + 前端同步） */
  async function clearMessages(id: string) {
    await chatApi.clearMessages(id)
    const { useMessagesStore } = await import('./messages')
    useMessagesStore().clearLocal(id)
    const conv = items.value.find(c => c.id === id)
    if (conv) {
      upsert({ ...conv, last_message_preview: null, last_message_at: null, unread_count: 0 })
    }
  }

  async function remove(id: string) {
    await chatApi.deleteConversation(id)
    items.value = items.value.filter(c => c.id !== id)
    pinned.value = pinned.value.filter(pid => pid !== id)
    pinnedTop.value = pinnedTop.value.filter(pid => pid !== id)
    persistPinnedTop()
    if (activeId.value === id) {
      activeId.value = items.value[0]?.id ?? null
      if (activeId.value) await select(activeId.value)
    }
  }

  function upsert(conv: Conversation) {
    const idx = items.value.findIndex(c => c.id === conv.id)
    if (idx >= 0) items.value[idx] = { ...items.value[idx], ...conv }
    else items.value.unshift(conv)
    sortItems()
  }

  /** 好友头像变更后，同步群聊成员缓存中对应的 bot（保证九宫格即时刷新） */
  function syncMemberBot(bot: Bot) {
    const next = { ...membersMap.value }
    let changed = false
    for (const id of Object.keys(next)) {
      const idx = next[id].findIndex(b => b.id === bot.id)
      if (idx >= 0) {
        next[id] = [...next[id]]
        next[id][idx] = { ...next[id][idx], ...bot }
        changed = true
      }
    }
    if (changed) membersMap.value = next
  }

  /** CLI 事件：conversation.updated */
  function applyUpdate(conv: Conversation) {
    // 正在查看的会话不产生未读
    if (conv.id === activeId.value && conv.unread_count > 0) {
      conv = { ...conv, unread_count: 0 }
      void chatApi.markConversationRead(conv.id)
    }
    upsert(conv)
  }

  return {
    items, activeId, active, chatList, totalUnread, membersMap, load, select, createPrivate, createGroup,
    loadMembers, addMember, removeMember, updateGroup, remove, applyUpdate, clearMessages, syncMemberBot,
    pinnedTop, isPinnedTop, togglePinTop,
  }
})
