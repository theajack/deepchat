import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { en } from '../i18n/en'
import { zh } from '../i18n/zh'
import type { EffectiveLocale, Locale } from '../i18n/types'

const STORAGE_KEY = 'deepchat:locale'

function systemLocale(): EffectiveLocale {
  if (typeof navigator === 'undefined') return 'en'
  const lang = navigator.language?.toLowerCase() ?? ''
  return lang.startsWith('zh') ? 'zh' : 'en'
}

function load(): Locale {
  if (typeof localStorage === 'undefined') return 'system'
  const v = localStorage.getItem(STORAGE_KEY) as Locale | null
  return v === 'zh' || v === 'en' || v === 'system' ? v : 'system'
}

export const useLocaleStore = defineStore('locale', () => {
  const locale = ref<Locale>(load())

  const effective = computed<EffectiveLocale>(() =>
    locale.value === 'system' ? systemLocale() : locale.value,
  )

  function t(key: string, params?: Record<string, string | number>): string {
    const dict = effective.value === 'en' ? en : zh
    let text = dict[key] ?? zh[key] ?? key
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.split(`{${k}}`).join(String(v))
      }
    }
    return text
  }

  function apply() {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = effective.value
    }
  }

  function setLocale(next: Locale) {
    locale.value = next
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* 忽略 */
    }
    apply()
  }

  function init() {
    apply()
  }

  return { locale, effective, t, setLocale, init }
})
