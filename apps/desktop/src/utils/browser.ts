import { agentApi } from '../services/agentApi'
import { useSettingsStore } from '../stores/settings'
import { normalizeUrl } from '../stores/browser'
import { t } from '../i18n'

/** 默认浏览器模式设置键 */
export const BROWSER_PREF_KEY = 'default_browser'
export type BrowserPref = 'builtin' | 'system'

/** 独立浏览器窗口的固定标签 */
const BROWSER_WINDOW_LABEL = 'browser'

/** 获取当前默认浏览器偏好 */
export function getBrowserPref(): BrowserPref {
  const settings = useSettingsStore()
  const val = settings.values[BROWSER_PREF_KEY]
  return val === 'system' ? 'system' : 'builtin'
}

/** 设置默认浏览器偏好 */
export async function setBrowserPref(pref: BrowserPref): Promise<void> {
  const settings = useSettingsStore()
  await settings.set(BROWSER_PREF_KEY, pref)
}

/**
 * 在内置浏览器中打开 URL：
 * - 窗口已存在 → 推送事件新增标签页并聚焦窗口
 * - 窗口不存在 → 创建独立窗口，初始地址通过 hash 传入
 */
export async function openUrlBuiltin(url: string): Promise<void> {
  const target = normalizeUrl(url)
  if (!target) return

  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(BROWSER_WINDOW_LABEL)

    if (existing) {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo(BROWSER_WINDOW_LABEL, 'browser:new-tab', { url: target })
      await existing.setFocus()
      return
    }

    const win = new WebviewWindow(BROWSER_WINDOW_LABEL, {
      url: `index.html#/browser?url=${encodeURIComponent(target)}`,
      title: t('browser.title'),
      width: 1100,
      height: 760,
      minWidth: 600,
      minHeight: 400,
      resizable: true,
      decorations: true,
      titleBarStyle: 'overlay',
      hiddenTitle: true,
      center: true,
    })

    await new Promise<void>((resolve, reject) => {
      win.once('tauri://created', () => resolve())
      win.once('tauri://error', e => reject(new Error(String(e.payload))))
      setTimeout(resolve, 3000)
    })
  } catch (e) {
    // 创建窗口失败时降级到系统浏览器
    console.error('[browser] 创建内置浏览器窗口失败，降级系统浏览器', e)
    await openUrlSystem(target)
  }
}

/** 使用系统默认浏览器打开（经 CLI 后端调用系统命令） */
export async function openUrlSystem(url: string): Promise<void> {
  await agentApi.toolOpenUrl(url)
}

/**
 * 根据全局设置打开 URL：
 * - "system" → 系统默认浏览器
 * - "builtin" → 应用内置浏览器窗口
 */
export async function openUrl(url: string, force?: BrowserPref): Promise<void> {
  const pref = force ?? getBrowserPref()
  if (pref === 'system') await openUrlSystem(url)
  else await openUrlBuiltin(url)
}
