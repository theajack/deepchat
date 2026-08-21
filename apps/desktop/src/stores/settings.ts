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
  }

  async function set(key: string, value: string) {
    await chatApi.setSetting(key, value)
    values.value = { ...values.value, [key]: value }
  }

  return { values, loaded, load, set }
})
