import { defineStore } from 'pinia'
import { ref } from 'vue'

const STORAGE_KEY = 'deepchat:sidebar-width'

/** 侧边栏（会话/好友/设置列表）共享宽度 */
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 420
const DEFAULT_WIDTH = 240

function load(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_WIDTH
  const v = Number(localStorage.getItem(STORAGE_KEY))
  return Number.isFinite(v) && v >= SIDEBAR_MIN_WIDTH && v <= SIDEBAR_MAX_WIDTH ? v : DEFAULT_WIDTH
}

/** 应用级 UI 状态：侧边栏共享宽度（会话列表 / 好友列表 / 设置列表） */
export const useUiStore = defineStore('ui', () => {
  const sidebarWidth = ref<number>(load())

  function setSidebarWidth(w: number) {
    const clamped = Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, w)))
    sidebarWidth.value = clamped
    try {
      localStorage.setItem(STORAGE_KEY, String(clamped))
    } catch {
      /* 忽略 */
    }
  }

  return { sidebarWidth, setSidebarWidth }
})
