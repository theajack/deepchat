import { nextTick, type Ref } from 'vue'

const SCROLL_THRESHOLD = 24 // px：距底部小于此值视为"在底部"

/**
 * 自动滚动到底部 composable：
 * - 内容变化时调用 maybeScrollToBottom（仅当用户"贴底"时才真正滚动）
 * - 用户上滑 → 关闭自动滚动
 * - 用户滑回底部 → 重新开启自动滚动
 *
 * @param scrollEl 滚动容器的 ref（HTMLElement）
 */
export function useAutoScroll(scrollEl: Ref<HTMLElement | null | undefined>) {
  /** 是否贴底（自动滚动开启） */
  let stickToBottom = true

  /** 用户滚动时更新贴底状态 */
  function onScroll() {
    const el = scrollEl.value
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottom = distFromBottom < SCROLL_THRESHOLD
  }

  /** 内容变化时，若贴底则自动滚到底部 */
  function maybeScrollToBottom() {
    nextTick(() => {
      const el = scrollEl.value
      if (!el || !stickToBottom) return
      el.scrollTo({ top: el.scrollHeight })
    })
  }

  /** 手动强制贴底（如展开时初始状态） */
  function forceScrollToBottom() {
    stickToBottom = true
    nextTick(() => {
      const el = scrollEl.value
      if (!el) return
      el.scrollTo({ top: el.scrollHeight })
    })
  }

  return {
    onScroll,
    maybeScrollToBottom,
    forceScrollToBottom,
    get isSticking() {
      return stickToBottom
    },
  }
}
