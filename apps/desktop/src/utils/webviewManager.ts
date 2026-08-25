import { invoke } from '@tauri-apps/api/core'
import { useBrowserStore, toWebviewUrl, type BrowserTab } from '../stores/browser'

/**
 * 原生 Webview 管理器：为每个 Tab 挂载一个真实的 Tauri Webview。
 *
 * webview 由 Rust 侧 command（browser_create_tab）创建——只有这样才能挂载
 * on_new_window（拦截 _blank / window.open 转为新标签）与
 * on_document_title_changed（标题上报）等原生钩子。
 * 外部网页的 JS 无法使用 Tauri IPC（远程 origin 被拦截），
 * 因此不做任何页面脚本注入，全部状态由 Rust 侧事件驱动。
 *
 * 导航控制通过 Rust 侧 command 实现：
 * - browser_back / browser_forward → history.back/forward
 * - browser_navigate → webview.navigate（追加历史）
 * - browser_reload → location.reload()
 *
 * 历史前进/后退可用性由前端维护的"逻辑历史指针"跟踪。
 */
/** Tauri Webview 的最小结构类型（避免引入运行时 import 与 any） */
interface ManagedWebview {
  setSize(size: unknown): Promise<void>
  setPosition(position: unknown): Promise<void>
  setFocus(): Promise<void>
  close(): Promise<void>
}

interface PointCtor {
  new (x: number, y: number): unknown
}

/** 创建中的 webview（防止并发重复创建） */
export class WebviewManager {
  private webviews = new Map<string, ManagedWebview>()
  private container: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private LogicalPositionCls: PointCtor | null = null
  private LogicalSizeCls: PointCtor | null = null
  private WebviewGet: (typeof import('@tauri-apps/api/webview'))['Webview'] | null = null
  /** 进行中的创建请求（label → promise），避免 tabs watch 与 submitAddress 并发重复创建 */
  private pendingCreates = new Map<string, Promise<void>>()
  private debug = true

  private log(...args: unknown[]) {
    if (this.debug) console.log('[WebviewManager]', ...args)
  }

  async init(container: HTMLElement) {
    this.container = container
    try {
      const [{ Webview }, { LogicalPosition, LogicalSize }] = await Promise.all([
        import('@tauri-apps/api/webview'),
        import('@tauri-apps/api/dpi'),
      ])
      this.WebviewGet = Webview
      this.LogicalPositionCls = LogicalPosition
      this.LogicalSizeCls = LogicalSize
      this.log('初始化完成')
    } catch (e) {
      console.error('[WebviewManager] init 失败', e)
      return
    }

    this.resizeObserver = new ResizeObserver(() => this.syncActiveGeometry())
    this.resizeObserver.observe(container)
    window.addEventListener('resize', this.onWindowResize)
  }

  destroy() {
    window.removeEventListener('resize', this.onWindowResize)
    this.resizeObserver?.disconnect()
    for (const wv of this.webviews.values()) {
      wv.close().catch(() => {})
    }
    this.webviews.clear()
  }

  private onWindowResize = () => this.syncActiveGeometry()

  private getGeometry(): { x: number; y: number; w: number; h: number } {
    if (!this.container) return { x: 0, y: 0, w: 0, h: 0 }
    const rect = this.container.getBoundingClientRect()
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.max(1, Math.round(rect.width)),
      h: Math.max(1, Math.round(rect.height)),
    }
  }

  /** 创建一个新的 webview 并加载 URL（经 Rust 命令创建，挂载原生钩子） */
  async createWebview(tab: BrowserTab): Promise<void> {
    if (this.webviews.has(tab.webviewLabel)) return
    if (this.pendingCreates.has(tab.webviewLabel)) {
      return this.pendingCreates.get(tab.webviewLabel)
    }
    if (!tab.url) return

    const url = await toWebviewUrl(tab.url)
    if (!url) return
    const geo = this.getGeometry()
    const store = useBrowserStore()
    const label = tab.webviewLabel

    this.log('创建 webview', { label, url, geo })

    const task = (async () => {
      try {
        await invoke('browser_create_tab', {
          label,
          url,
          x: geo.x,
          y: geo.y,
          width: geo.w,
          height: geo.h,
        })

        // 取得 webview 句柄用于几何控制
        if (this.WebviewGet) {
          const wv = await this.WebviewGet.getByLabel(label)
          if (wv) this.webviews.set(label, wv as unknown as ManagedWebview)
        }
        // 加载状态由 Rust on_page_load 事件驱动（started / load）
      } catch (e) {
        console.error('[WebviewManager] browser_create_tab 失败', label, e)
        store.updateTab(tab.id, { loading: false })
      } finally {
        this.pendingCreates.delete(label)
      }
    })()

    this.pendingCreates.set(label, task)
    await task
  }

  async setActive(activeLabel: string): Promise<void> {
    if (!this.LogicalPositionCls || !this.LogicalSizeCls) return
    const geo = this.getGeometry()
    for (const [label, wv] of this.webviews) {
      try {
        if (label === activeLabel) {
          await wv.setSize(new this.LogicalSizeCls(geo.w, geo.h))
          await wv.setPosition(new this.LogicalPositionCls(geo.x, geo.y))
          await wv.setFocus()
        } else {
          await wv.setPosition(new this.LogicalPositionCls(-99999, -99999))
        }
      } catch (e) {
        console.error('[WebviewManager] setActive 失败', label, e)
      }
    }
  }

  async hideAll(): Promise<void> {
    if (!this.LogicalPositionCls) return
    for (const wv of this.webviews.values()) {
      await wv.setPosition(new this.LogicalPositionCls(-99999, -99999)).catch(() => {})
    }
  }

  async closeWebview(label: string): Promise<void> {
    const wv = this.webviews.get(label)
    if (!wv) return
    this.webviews.delete(label)
    await wv.close().catch(() => {})
  }

  /** 判断指定 label 的 webview 是否已创建 */
  has(label: string): boolean {
    return this.webviews.has(label)
  }

  // ============ 导航控制（通过 Rust command 驱动，不重建 webview） ============

  /** 后退 */
  async back(label: string): Promise<void> {
    await invoke('browser_back', { label }).catch((e) => {
      console.error('[WebviewManager] back failed', e)
    })
  }

  /** 前进 */
  async forward(label: string): Promise<void> {
    await invoke('browser_forward', { label }).catch((e) => {
      console.error('[WebviewManager] forward failed', e)
    })
  }

  /** 刷新（不重建 webview） */
  async reload(label: string): Promise<void> {
    await invoke('browser_reload', { label }).catch((e) => {
      console.error('[WebviewManager] reload failed', e)
    })
  }

  /** 地址栏导航（在当前 webview 追加历史） */
  async navigate(label: string, url: string): Promise<void> {
    const target = await toWebviewUrl(url)
    if (!target) return
    await invoke('browser_navigate', { label, url: target }).catch((e) => {
      console.error('[WebviewManager] navigate failed', e)
    })
  }

  async syncActiveGeometry(): Promise<void> {
    const store = useBrowserStore()
    const active = store.activeTab
    if (!active) return
    await this.setActive(active.webviewLabel)
  }
}
