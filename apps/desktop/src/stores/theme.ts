import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'deepchat:theme'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

/**
 * 默认跟随系统：未做过选择的新用户交给 OS 配色决定。
 *
 * 已选过的用户 localStorage 里存着 light/dark/system，走下面的原样返回分支，
 * 不受这个默认值影响。
 */
function load(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(STORAGE_KEY) as ThemeMode | null
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(load())
  const systemDark = ref(systemPrefersDark())

  const effective = computed<'light' | 'dark'>(() =>
    mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value,
  )

  function apply() {
    const root = document.documentElement
    root.classList.toggle('dark', effective.value === 'dark')
    root.dataset.theme = effective.value
  }

  function applyWithTransition(origin?: { x: number; y: number }) {
    const root = document.documentElement
    root.style.setProperty('--vt-x', `${origin?.x ?? window.innerWidth / 2}px`)
    root.style.setProperty('--vt-y', `${origin?.y ?? window.innerHeight / 2}px`)

    const vt = (document as unknown as { startViewTransition?: (cb: () => void) => { finished: Promise<void> } })
      .startViewTransition
    if (typeof vt === 'function') {
      try {
        vt.call(document, apply)
        return
      } catch {
        /* 降级 */
      }
    }
    apply()
  }

  function setMode(next: ThemeMode, origin?: { x: number; y: number }) {
    mode.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 忽略 */
    }
    applyWithTransition(origin)
  }

  let mql: MediaQueryList | undefined
  function init() {
    apply()
    if (typeof window !== 'undefined' && window.matchMedia) {
      mql = window.matchMedia('(prefers-color-scheme: dark)')
      mql.addEventListener('change', (e) => {
        systemDark.value = e.matches
        if (mode.value === 'system') apply()
      })
    }
  }

  return { mode, systemDark, effective, init, setMode, apply }
})
