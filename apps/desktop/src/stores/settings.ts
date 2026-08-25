import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'

/** 设置模块：API Key 等本地配置 */
export const useSettingsStore = defineStore('settings', () => {
  const values = ref<Record<string, string>>({})
  const loaded = ref(false)

  async function load() {
    values.value = await chatApi.allSettings()
    loaded.value = true
    // 本地调试日志开关同步到 dsh 宿主（宿主重启后会丢失内存态，前端每次
    // 启动时以 localStorage 的持久值为准重新下发）
    try {
      await chatApi.debugLog(values.value['debug_log_enabled'] === 'true')
    } catch { /* 宿主未就绪时忽略 */ }
  }

  async function set(key: string, value: string) {
    await chatApi.setSetting(key, value)
    values.value = { ...values.value, [key]: value }
  }

  return { values, loaded, load, set }
})
