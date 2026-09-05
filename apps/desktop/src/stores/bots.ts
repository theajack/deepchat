import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'
import { useAppStore } from './app'
import { t } from '../i18n'
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

  /**
   * 克隆好友：新 id、名字带「-克隆体」后缀，配置与记忆复制自源好友，
   * 历史会话不复制（服务端已将其总结写入克隆体的记忆文件）。
   *
   * 新好友放入列表**最前**而不是追加到末尾：好友列表是增量渲染的
   * （首屏只渲染 20 项，滚动才追加），追加到末尾时一旦总项数超过首屏
   * 上限，克隆结果就被 slice 截断，用户看不到任何反馈。
   */
  async function clone(id: string): Promise<Bot> {
    // 克隆词按当前界面语言取：宿主没有 i18n，命名在服务端完成但需要词本身
    const bot = await chatApi.cloneBot(id, t('contacts.cloneSuffix'))
    items.value = [bot, ...items.value]
    // Toast 放在 store 里：详情页面板与会话列表右键菜单都会走这里，
    // 两处入口自动获得一致的完成反馈，无需各自重复提示。
    useAppStore().toast(t('contacts.clonedBot', { name: bot.name }))
    return bot
  }

  return { items, loaded, load, create, update, remove, clone }
})
