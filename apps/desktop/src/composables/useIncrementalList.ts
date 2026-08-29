import { computed, ref, type ComputedRef } from 'vue'

/**
 * 列表增量渲染：一次只渲染 `pageSize` 项，滚动接近底部时追加一页。
 *
 * 首屏只挂载可见数量级的行组件，避免会话/好友较多时一次性渲染整张列表。
 * 排序由调用方的源数组决定，这里只控制「渲染到第几项」。
 */
export interface IncrementalList<T> {
  /** 当前应渲染的切片 */
  visible: ComputedRef<T[]>
  /** 是否还有未渲染的项（用于展示「滚动加载更多」提示） */
  hasMore: ComputedRef<boolean>
  /** 滚动容器事件回调：命中底部阈值时追加一页 */
  onScroll: (e: Event) => void
  /** 手动追加一页（底部提示点击兜底） */
  loadMore: () => void
  /** 重置渲染窗口（搜索关键字变化等场景） */
  reset: () => void
}

/** 距底部小于此值即视为触底（px） */
const BOTTOM_THRESHOLD = 120

export function useIncrementalList<T>(
  source: () => readonly T[],
  pageSize = 20,
): IncrementalList<T> {
  const limit = ref(pageSize)

  const visible = computed(() => source().slice(0, limit.value))
  const hasMore = computed(() => limit.value < source().length)

  function loadMore(): void {
    if (!hasMore.value) return
    limit.value += pageSize
  }

  function onScroll(e: Event): void {
    const el = e.target as HTMLElement | null
    if (!el) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD) loadMore()
  }

  function reset(): void {
    limit.value = pageSize
  }

  return { visible, hasMore, onScroll, loadMore, reset }
}
