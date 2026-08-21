import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { chatApi } from '../services/chatApi'
import { dicebearUrl, randomSeed } from '../utils/avatar'

/** 用户本人资料模块：昵称、头像、个人介绍，持久化到 settings 表 */
export const SELF_KEY = {
  name: 'self_name',
  avatar: 'self_avatar',
  intro: 'self_intro',
}

/** 用于 settings 中标记 avatar 已初始化（避免每次启动重新随机） */
const SELF_AVATAR_INIT = 'self_avatar_initialized'

export const useSelfStore = defineStore('self', () => {
  const name = ref('Me')
  const avatar = ref<string | null>(null)
  const intro = ref('')
  const loaded = ref(false)

  const displayName = computed(() => name.value.trim() || 'Me')

  async function load() {
    const all = await chatApi.allSettings()
    name.value = all[SELF_KEY.name] || 'Me'
    avatar.value = all[SELF_KEY.avatar] || null
    intro.value = all[SELF_KEY.intro] || ''
    // 首次使用：自动随机生成头像
    if (!all[SELF_AVATAR_INIT]) {
      const url = dicebearUrl('bottts-neutral', randomSeed())
      avatar.value = url
      await chatApi.setSetting(SELF_KEY.avatar, url)
      await chatApi.setSetting(SELF_AVATAR_INIT, '1')
    }
    loaded.value = true
  }

  async function setName(v: string) {
    name.value = v
    await chatApi.setSetting(SELF_KEY.name, v)
  }

  async function setAvatar(v: string | null) {
    avatar.value = v
    await chatApi.setSetting(SELF_KEY.avatar, v ?? '')
  }

  async function setIntro(v: string) {
    intro.value = v
    await chatApi.setSetting(SELF_KEY.intro, v)
  }

  /** 一次性更新所有字段 */
  async function saveAll(data: { name?: string; avatar?: string | null; intro?: string }) {
    if (data.name !== undefined) {
      name.value = data.name
      await chatApi.setSetting(SELF_KEY.name, data.name)
    }
    if (data.avatar !== undefined) {
      avatar.value = data.avatar
      await chatApi.setSetting(SELF_KEY.avatar, data.avatar ?? '')
    }
    if (data.intro !== undefined) {
      intro.value = data.intro
      await chatApi.setSetting(SELF_KEY.intro, data.intro)
    }
  }

  return { name, avatar, intro, displayName, loaded, load, setName, setAvatar, setIntro, saveAll }
})
