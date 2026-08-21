import { reactive } from 'vue'

/**
 * 好友详情 hover 浮层全局状态（单例）：
 * 全局只挂载一个 BotDetailPopover，各触发点（群聊头像 / 会话列表项）
 * 通过 show/hide 改变其位置与内容，避免多处实例。
 */
export const botDetailHover = reactive({
  botId: null as string | null,
  anchorEl: null as HTMLElement | null,
})

let hideTimer: ReturnType<typeof setTimeout> | undefined
let showTimer: ReturnType<typeof setTimeout> | undefined
/** 延迟隐藏（ms）：给鼠标从触发区移到浮层留出时间 */
const HIDE_DELAY = 150
/** 延迟显示（ms）：避免鼠标快速扫过时闪烁 */
const SHOW_DELAY = 250

/** 显示详情浮层：定位到触发元素右侧（延迟显示，可被 hideBotDetail 取消） */
export function showBotDetail(botId: string, el: HTMLElement): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
  // 已显示且是同一 bot：仅更新锚点（切换触发点时不闪烁）
  if (botDetailHover.botId === botId) {
    botDetailHover.anchorEl = el
    return
  }
  if (showTimer) clearTimeout(showTimer)
  showTimer = setTimeout(() => {
    showTimer = undefined
    botDetailHover.botId = botId
    botDetailHover.anchorEl = el
  }, SHOW_DELAY)
}

/** 立即取消待显示的浮层（鼠标快速离开触发区） */
export function cancelBotDetail(): void {
  if (showTimer) {
    clearTimeout(showTimer)
    showTimer = undefined
  }
}

/** 隐藏详情浮层（延迟，可被 show / keepBotDetail 取消；同时取消待显示） */
export function hideBotDetail(): void {
  cancelBotDetail()
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    botDetailHover.botId = null
    botDetailHover.anchorEl = null
  }, HIDE_DELAY)
}

/** 取消隐藏（浮层自身被 hover 时调用） */
export function keepBotDetail(): void {
  if (hideTimer) {
    clearTimeout(hideTimer)
    hideTimer = undefined
  }
}
