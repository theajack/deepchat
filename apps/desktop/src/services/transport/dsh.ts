/**
 * dsh host 传输层：与 `dsh --profile chat-agent` 启动的本地 host
 * (默认 http://127.0.0.1:3180) 通过 HTTP + WebSocket 通信。
 *
 * - HTTP 走 tauri-plugin-http（绕过 webview CORS 限制），在纯浏览器
 *   环境回退到原生 fetch
 * - 事件走 /api/events.mux WebSocket（WS 不受 CORS 约束），断线自动重连
 */

/** dsh 一元 RPC 信封（POST /api/<method> 的请求体） */
export interface DshRpcRequest {
  rpcId: string
  payload: unknown
}

export interface DshRpcResponse<T = unknown> {
  rpcId: string
  result?: { ok?: T }
  error?: { code: string; message: string }
}

/** mux 事件帧（下行 WS） */
export interface DshMuxFrame {
  type: string
  [key: string]: unknown
}

export function dshBaseUrl(): string {
  const injected = (window as unknown as { __DSH_BASE__?: string }).__DSH_BASE__
  if (injected) return injected
  const env = import.meta.env.VITE_DSH_BASE as string | undefined
  return env ?? 'http://127.0.0.1:3180'
}

/** 是否运行在 Tauri webview 中 */
function inTauri(): boolean {
  return '__TAURI_INTERNALS__' in window
}

/** 免 CORS 的 fetch：Tauri 内走 plugin-http，浏览器内走原生 fetch */
export async function dshFetch(path: string, init?: RequestInit): Promise<Response> {
  if (inTauri()) {
    try {
      const { fetch } = await import('@tauri-apps/plugin-http')
      return await fetch(dshBaseUrl() + path, init)
    } catch {
      // plugin 不可用时退回原生 fetch（开发调试用）
    }
  }
  return fetch(dshBaseUrl() + path, init)
}

/** JSON GET */
export async function dshGet<T>(path: string): Promise<T> {
  const res = await dshFetch(path)
  if (!res.ok) throw new Error(`${path}: HTTP ${String(res.status)}`)
  return await res.json() as T
}

/** JSON 写请求（GET/HEAD 不允许携带 body，自动省略） */
export async function dshSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const hasBody = method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD' && body !== undefined
  const res = await dshFetch(path, {
    method,
    ...(hasBody
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const json = await res.json() as T & { error?: unknown }
  if (!res.ok) throw new Error(`${path}: HTTP ${String(res.status)} ${String(json.error ?? '')}`)
  return json
}

/** 调用 dsh 标准一元 RPC（POST /api/<method>，JSON 信封） */
export async function dshRpc<T = unknown>(method: string, payload: unknown = {}): Promise<T> {
  const envelope: DshRpcRequest = { rpcId: crypto.randomUUID(), payload }
  const res = await dshFetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
  const body = await res.json() as DshRpcResponse<T>
  if (body.error) throw new Error(`${method}: ${body.error.code} ${body.error.message}`)
  return (body.result ?? undefined) as T
}

/** 订阅 dsh mux 事件流；返回取消函数 */
export function dshEvents(onFrame: (frame: DshMuxFrame) => void): () => void {
  let ws: WebSocket | undefined
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const connect = (): void => {
    if (disposed) return
    const url = dshBaseUrl().replace(/^http/, 'ws') + '/api/events.mux'
    try {
      ws = new WebSocket(url)
    } catch {
      scheduleRetry()
      return
    }
    ws.onmessage = (event) => {
      try {
        const frame = JSON.parse(event.data as string) as DshMuxFrame
        onFrame(frame)
      } catch {
        // 非 JSON 帧忽略
      }
    }
    ws.onclose = () => scheduleRetry()
    ws.onerror = () => ws?.close()
  }

  const scheduleRetry = (): void => {
    if (disposed) return
    retryTimer = setTimeout(connect, 3000)
  }

  connect()
  return () => {
    disposed = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    ws?.close()
  }
}

/** chat 业务事件帧（SSE `/chatapi/events` 下行） */
export interface ChatEventFrame {
  event: string
  data: unknown
}

/**
 * 订阅 chat 业务事件流（legacy 事件形状：message.stream / message.created /
 * bot.typing / agent.tool.* / conversation.updated）。SSE 端点带 CORS 头，
 * Tauri webview 与浏览器均可直连；断线自动重连。
 */
export function dshChatEvents(onFrame: (frame: ChatEventFrame) => void): () => void {
  let source: EventSource | undefined
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const connect = (): void => {
    if (disposed) return
    source = new EventSource(dshBaseUrl() + '/chatapi/events')
    source.onmessage = (message) => {
      try {
        onFrame(JSON.parse(message.data) as ChatEventFrame)
      } catch {
        // 非 JSON 帧忽略
      }
    }
    source.onerror = () => {
      // EventSource 自动重连；仅在连接已关闭时手动兜底重连
      if (source?.readyState === EventSource.CLOSED) {
        source.close()
        if (!disposed) retryTimer = setTimeout(connect, 3000)
      }
    }
  }

  connect()
  return () => {
    disposed = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    source?.close()
  }
}
