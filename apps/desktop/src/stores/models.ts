import { defineStore } from 'pinia'
import { ref } from 'vue'
import { chatApi } from '../services/chatApi'
import type { ModelConfig, ModelInput } from '../types'

/** 模型配置模块（SRP：仅负责模型 CRUD 状态） */
export const useModelsStore = defineStore('models', () => {
  const items = ref<ModelConfig[]>([])
  const loaded = ref(false)

  async function load() {
    items.value = await chatApi.listModels()
    loaded.value = true
  }

  async function create(input: ModelInput): Promise<ModelConfig> {
    const model = await chatApi.createModel(input)
    items.value.push(model)
    return model
  }

  async function update(id: string, patch: Partial<ModelInput>): Promise<ModelConfig> {
    const model = await chatApi.updateModel(id, patch)
    const idx = items.value.findIndex(m => m.id === id)
    if (idx >= 0) items.value[idx] = model
    return model
  }

  async function remove(id: string): Promise<void> {
    await chatApi.deleteModel(id)
    items.value = items.value.filter(m => m.id !== id)
  }

  return { items, loaded, load, create, update, remove }
})
