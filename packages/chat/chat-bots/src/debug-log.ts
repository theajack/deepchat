/**
 * Local debug log for the settings Debug panel — the migrated counterpart of
 * the legacy chat-agent `cli.log`. When `debug_log_enabled` is on, every SSE
 * event broadcast (message streaming, tool lifecycle, errors) is appended to
 * `$DSH_HOME/logs/debug.log` so issues can be diagnosed from a file even when
 * the devtools console is unavailable.
 *
 * @module @deepseek-ai/dsh-chat-bots/debug-log
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Log file location inside the dsh home. */
export const DEBUG_LOG_PATH = join(process.env.DSH_HOME ?? '', 'logs', 'debug.log')

let enabled = false

function ensureDir(): void {
  try {
    mkdirSync(join(DEBUG_LOG_PATH, '..'), { recursive: true })
  } catch {
    /* 日志写入失败不应影响主流程 */
  }
}

/** 格式化任意值（含嵌套 cause 的错误）为可读单行字符串 */
export function formatDebugValue(value: unknown): string {
  if (value == null) return 'null'
  if (value instanceof Error) {
    const parts = [`name=${value.name}`, `message=${value.message}`]
    const cause = (value as { cause?: unknown }).cause
    if (cause != null) parts.push(`cause=${formatDebugValue(cause)}`)
    try {
      return JSON.stringify({ parts, stack: value.stack?.split('\n').slice(0, 4).join(' | ') })
    } catch {
      return String(value)
    }
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 开关实时生效（写入侧检查；关闭时不产生任何 IO） */
export function configureDebugLog(on: boolean): void {
  enabled = on
}

export function isDebugLogEnabled(): boolean {
  return enabled
}

/** 记录一条调试日志（仅开关开启时写入） */
export function debugLog(event: string, data?: unknown): void {
  if (!enabled) return
  ensureDir()
  const line = `[${new Date().toISOString()}][DEBUG] ${event}${data !== undefined ? ` ${formatDebugValue(data)}` : ''}\n`
  try {
    appendFileSync(DEBUG_LOG_PATH, line)
  } catch {
    /* 日志写入失败不应影响主流程 */
  }
}

/** 读取最近 n 行日志（面板预览用）；无文件时返回提示文案 */
export function tailDebugLog(n = 200): string {
  try {
    const lines = readFileSync(DEBUG_LOG_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-n).join('\n')
  } catch {
    return existsSync(DEBUG_LOG_PATH) ? '日志文件无法读取' : '暂无日志'
  }
}
