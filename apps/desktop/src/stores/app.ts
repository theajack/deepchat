import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Bot, Conversation } from '../types'

export type ViewName = 'chat' | 'contacts' | 'settings'

const SETTINGS_SECTION_KEY = 'chat-agent:settings-section'

/** 应用级 UI 状态：视图导航、弹窗、Toast */
export const useAppStore = defineStore('app', () => {
  const view = ref<ViewName>('chat')
  const toastText = ref('')
  /** 正在编辑的 bot；null = 关闭；'new' = 新建 */
  const editingBot = ref<Bot | 'new' | null>(null)
  /** 正在编辑的群聊；null = 关闭；'new' = 新建 */
  const editingGroup = ref<Conversation | 'new' | null>(null)
  /** 新建群聊时的默认勾选成员 */
  const groupEditorPreset = ref<string[] | null>(null)
  /** 设置页二级面板 id（持久化到 localStorage，供跨视图跳转） */
  const settingsSection = ref<string>(
    (() => {
      try {
        return localStorage.getItem(SETTINGS_SECTION_KEY) || 'me'
      } catch {
        return 'me'
      }
    })(),
  )

  let toastTimer: ReturnType<typeof setTimeout> | undefined

  function navigate(v: ViewName) {
    view.value = v
  }
  /** 跳转到设置页指定二级面板 */
  function navigateToSettings(section: string) {
    settingsSection.value = section
    view.value = 'settings'
    try {
      localStorage.setItem(SETTINGS_SECTION_KEY, section)
    } catch {
      /* 忽略 */
    }
  }
  function toast(msg: string) {
    toastText.value = msg
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toastText.value = ''), 1800)
  }
  function openBotEditor(bot?: Bot) {
    editingBot.value = bot ?? 'new'
  }
  function closeBotEditor() {
    editingBot.value = null
  }
  function openGroupEditor(group?: Conversation, presetMemberIds?: string[]) {
    editingGroup.value = group ?? 'new'
    groupEditorPreset.value = group ? null : (presetMemberIds ?? null)
  }
  function closeGroupEditor() {
    editingGroup.value = null
    groupEditorPreset.value = null
  }

  return {
    view, toastText, editingBot, editingGroup, groupEditorPreset, settingsSection,
    navigate, navigateToSettings, toast, openBotEditor, closeBotEditor, openGroupEditor, closeGroupEditor,
  }
})
