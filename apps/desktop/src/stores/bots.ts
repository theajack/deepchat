import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'
import type { Bot, BotInput } from '../types'

/** AI 好友模块 */
export const useBotsStore = defineStore('bots', () => {
  const items = ref<Bot[]>([])
  const loaded = ref(false)

  async function load() {
    items.value = await chatApi.listBots()
    loaded.value = true
  }

  async function create(input: BotInput): Promise<Bot> {
    const bot = await chatApi.createBot(input)
    items.value.push(bot)
    return bot
  }

  async function update(id: string, patch: Partial<BotInput>): Promise<void> {
    const bot = await chatApi.updateBot(id, patch)
    const idx = items.value.findIndex(b => b.id === id)
    if (idx >= 0) items.value[idx] = bot
    // 同步群聊九宫格里的成员头像（避免编辑好友后群聊头像不刷新）
    const { useConversationsStore } = await import('./conversations')
    useConversationsStore().syncMemberBot(bot)
  }

  async function remove(id: string): Promise<void> {
    await chatApi.deleteBot(id)
    items.value = items.value.filter(b => b.id !== id)
  }

  return { items, loaded, load, create, update, remove }
})
