import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

/** 单个标签页元数据（真实内容由原生 Webview 承载） */
export interface BrowserTab {
  id: string
  /** Webview 的 label（Tauri 端唯一标识） */
  webviewLabel: string
  /** 当前地址（用户可见形式） */
  url: string
  /** 页面标题 */
  title: string
  /** 加载中 */
  loading: boolean
  /** 前端维护的历史栈：URL 序列 */
  history: string[]
  /** 历史指针 */
  historyIndex: number
  /** 后退可用 */
  canBack: boolean
  /** 前进可用 */
  canForward: boolean
}

let seq = 0
function nextLabel(): string {
  seq++
  return `browser-tab-${Date.now()}-${seq}`
}

function createTab(url: string): BrowserTab {
  return {
    id: crypto.randomUUID(),
    webviewLabel: nextLabel(),
    url,
    title: '',
    loading: Boolean(url),
    history: url ? [url] : [],
    historyIndex: url ? 0 : -1,
    canBack: false,
    canForward: false,
  }
}

/** 内置浏览器多标签状态 */
export const useBrowserStore = defineStore('browser', () => {
  const tabs = ref<BrowserTab[]>([])
  const activeId = ref<string>('')

  const activeTab = computed(() => tabs.value.find(t => t.id === activeId.value) ?? null)

  function findTab(id: string): BrowserTab | undefined {
    return tabs.value.find(t => t.id === id)
  }

  function addTab(rawUrl: string, activate = true): string {
    const normalized = normalizeUrl(rawUrl)
    const tab = createTab(normalized)
    tabs.value = [...tabs.value, tab]
    if (activate || !activeId.value) activeId.value = tab.id
    return tab.id
  }

  function closeTab(id: string) {
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx < 0) return
    const wasActive = activeId.value === id
    tabs.value = tabs.value.filter(t => t.id !== id)
    if (wasActive) {
      const next = tabs.value[Math.min(idx, tabs.value.length - 1)]
      activeId.value = next?.id ?? ''
    }
  }

  function activateTab(id: string) {
    if (findTab(id)) activeId.value = id
  }

  function moveTab(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= tabs.value.length || to >= tabs.value.length) return
    const next = [...tabs.value]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    tabs.value = next
  }

  function updateTab(id: string, patch: Partial<BrowserTab>) {
    const tab = findTab(id)
    if (!tab) return
    Object.assign(tab, patch)
    tabs.value = [...tabs.value]
  }

  /**
   * 推进 tab 历史（用户主动导航时调用）。
   * 会截断当前指针之后的历史，追加新地址。
   */
  function pushHistory(id: string, url: string) {
    const tab = findTab(id)
    if (!tab || !url) return
    // 与当前地址相同则不追加，避免重复
    if (tab.history[tab.historyIndex] === url) return
    tab.history = [...tab.history.slice(0, tab.historyIndex + 1), url]
    tab.historyIndex = tab.history.length - 1
    tab.url = url
    tab.canBack = tab.historyIndex > 0
    tab.canForward = false
    tabs.value = [...tabs.value]
  }

  /** 前进/后退时更新指针（不修改历史栈） */
  function moveHistory(id: string, delta: -1 | 1) {
    const tab = findTab(id)
    if (!tab) return
    const next = tab.historyIndex + delta
    if (next < 0 || next >= tab.history.length) return
    tab.historyIndex = next
    tab.url = tab.history[next]
    tab.canBack = tab.historyIndex > 0
    tab.canForward = tab.historyIndex < tab.history.length - 1
    tabs.value = [...tabs.value]
  }

  /** 从 tab 上报同步当前 URL（若与预期不同则推进历史） */
  function syncUrl(id: string, url: string) {
    const tab = findTab(id)
    if (!tab || !url) return
    // 与当前指针指向的 URL 一致 → 只是 popstate / 页面重新报告，不动历史
    if (tab.history[tab.historyIndex] === url) {
      tab.url = url
      tabs.value = [...tabs.value]
      return
    }
    // 与历史中某项匹配 → 视为 back/forward 导航（页面内 popstate）
    const idx = tab.history.indexOf(url)
    if (idx >= 0) {
      tab.historyIndex = idx
      tab.url = url
      tab.canBack = tab.historyIndex > 0
      tab.canForward = tab.historyIndex < tab.history.length - 1
      tabs.value = [...tabs.value]
      return
    }
    // 新地址 → 追加历史
    pushHistory(id, url)
  }

  return {
    tabs,
    activeId,
    activeTab,
    addTab,
    closeTab,
    activateTab,
    moveTab,
    updateTab,
    pushHistory,
    moveHistory,
    syncUrl,
  }
})

/** 将用户输入规范化为可加载的地址 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^(https?|file):\/\//i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/')) return `file://${trimmed}`
  if (/^(localhost|\d+\.\d+\.\d+\.\d+)/i.test(trimmed)) return `http://${trimmed}`
  if (/\s/.test(trimmed) || !trimmed.includes('.')) {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
  }
  return `https://${trimmed}`
}

/** 将 file:// 转换为 Tauri asset 协议 URL（Webview 也支持） */
export async function toWebviewUrl(url: string): Promise<string> {
  if (!url) return ''
  if (!url.startsWith('file://')) return url
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core')
    const filePath = decodeURIComponent(url.replace(/^file:\/\//i, ''))
    return convertFileSrc(filePath)
  } catch {
    return url
  }
}

/** 用于地址栏展示的简短形式 */
export function displayUrl(url: string): string {
  if (url.startsWith('file://')) return decodeURIComponent(url.replace(/^file:\/\//i, ''))
  return url
}
