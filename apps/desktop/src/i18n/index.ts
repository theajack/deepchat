import { useLocaleStore } from '../stores/locale'
import type { EffectiveLocale, Locale, MessageDict } from './types'

/** 全局翻译函数，可在组件模板与普通 TS 模块（stores/utils/services）中直接调用。 */
export function t(key: string, params?: Record<string, string | number>): string {
  return useLocaleStore().t(key, params)
}

/** 组合式函数：返回响应式的 locale/effective 及 t、setLocale。 */
export function useI18n() {
  const store = useLocaleStore()
  return {
    locale: store.locale,
    effective: store.effective,
    t: store.t,
    setLocale: store.setLocale,
  }
}

export { en } from './en'
export { zh } from './zh'
export type { EffectiveLocale, Locale, MessageDict }
