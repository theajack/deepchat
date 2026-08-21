import { t } from '../i18n'

/** 对话信息窗口的固定标签 */
const LLM_TRACE_WINDOW_LABEL = 'llm-trace'

/**
 * 打开「对话信息」调试窗口：
 * - 窗口已存在 → 聚焦并刷新
 * - 窗口不存在 → 创建独立窗口，地址通过 hash 传入
 */
export async function openLlmTraceWindow(): Promise<void> {
  try {
    const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
    const existing = await WebviewWindow.getByLabel(LLM_TRACE_WINDOW_LABEL)

    if (existing) {
      const { emitTo } = await import('@tauri-apps/api/event')
      await emitTo(LLM_TRACE_WINDOW_LABEL, 'llm-trace:refresh', {})
      await existing.setFocus()
      return
    }

    const win = new WebviewWindow(LLM_TRACE_WINDOW_LABEL, {
      url: 'index.html#/llm-trace',
      title: t('debug.llmTraceTitle'),
      width: 1000,
      height: 760,
      minWidth: 640,
      minHeight: 420,
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
    console.error('[llm-trace] 创建对话信息窗口失败', e)
  }
}
