import { invoke } from '@tauri-apps/api/core'
import { useBrowserStore, toWebviewUrl, type BrowserTab } from '../stores/browser'

/**
 * 原生 Webview 管理器：为每个 Tab 挂载一个真实的 Tauri Webview。
 *
 * 导航控制通过 Rust 侧 command 实现：
 * - browser_back / browser_forward → history.back/forward
 * - browser_navigate → webview.navigate（追加历史）
 * - browser_reload → webview.reload
 *
 * 历史前进/后退可用性由前端维护的"逻辑历史指针"跟踪。
 */
/** Tauri Webview 的最小结构类型（避免引入运行时 import 与 any） */
interface ManagedWebview {
  once(event: string, listener: (event: unknown) => void): void
  setSize(size: unknown): Promise<void>
  setPosition(position: unknown): Promise<void>
  setFocus(): Promise<void>
  close(): Promise<void>
}

interface WebviewCtor {
  new (window: unknown, label: string, options: {
    url: string
    x: number
    y: number
    width: number
    height: number
    focus?: boolean
  }): ManagedWebview
}

interface PointCtor {
  new (x: number, y: number): unknown
}

interface HostWindow {
  label?: string
}

export class WebviewManager {
  private webviews = new Map<string, ManagedWebview>()
  private container: HTMLElement | null = null
  private resizeObserver: ResizeObserver | null = null
  private WebviewCls: WebviewCtor | null = null
  private LogicalPositionCls: PointCtor | null = null
  private LogicalSizeCls: PointCtor | null = null
  private currentWindow: HostWindow | null = null
  private debug = true

  private log(...args: unknown[]) {
    if (this.debug) console.log('[WebviewManager]', ...args)
  }

  async init(container: HTMLElement) {
    this.container = container
    try {
      const [{ getCurrentWindow }, { Webview }, { LogicalPosition, LogicalSize }] = await Promise.all([
        import('@tauri-apps/api/window'),
        import('@tauri-apps/api/webview'),
        import('@tauri-apps/api/dpi'),
      ])
      this.WebviewCls = Webview as unknown as WebviewCtor
      this.LogicalPositionCls = LogicalPosition
      this.LogicalSizeCls = LogicalSize
      this.currentWindow = getCurrentWindow()
      this.log('初始化完成', 'window.label=', this.currentWindow?.label)
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

  /** 创建一个新的 webview 并加载 URL */
  async createWebview(tab: BrowserTab): Promise<void> {
    if (!this.WebviewCls || !this.currentWindow) return
    if (this.webviews.has(tab.webviewLabel)) return
    if (!tab.url) return

    const url = await toWebviewUrl(tab.url)
    const geo = this.getGeometry()
    const store = useBrowserStore()

    this.log('创建 webview', { label: tab.webviewLabel, url, geo })

    try {
      const wv = new this.WebviewCls(this.currentWindow, tab.webviewLabel, {
        url,
        x: geo.x,
        y: geo.y,
        width: geo.w,
        height: geo.h,
        focus: false,
      })

      this.webviews.set(tab.webviewLabel, wv)

      const created = await new Promise<boolean>((resolve) => {
        let done = false
        const finish = (ok: boolean, err?: unknown) => {
          if (done) return
          done = true
          if (!ok) console.error('[WebviewManager] webview 创建失败', tab.webviewLabel, err)
          resolve(ok)
        }
        wv.once('tauri://created', () => finish(true))
        wv.once('tauri://error', (e: unknown) => finish(false, e))
        setTimeout(() => finish(false, 'timeout'), 8000)
      })

      if (!created) {
        this.webviews.delete(tab.webviewLabel)
        store.updateTab(tab.id, { loading: false })
        return
      }

      // 注入 tab 状态上报脚本
      await invoke('browser_install_tab_script', { label: tab.webviewLabel }).catch((e) => {
        console.warn('[WebviewManager] install script 失败', e)
      })

      // 页面加载完成状态由 tab-state 事件驱动，此处兜底
      setTimeout(() => store.updateTab(tab.id, { loading: false }), 1500)
    } catch (e) {
      console.error('[WebviewManager] new Webview 抛异常', tab.webviewLabel, e)
      this.webviews.delete(tab.webviewLabel)
    }
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
