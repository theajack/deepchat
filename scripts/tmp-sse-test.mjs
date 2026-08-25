import http from 'node:http'

const BASE = 'http://127.0.0.1:3180'
const BOT = process.argv[2] ?? 'bot-c649f60e-a3b2-4c84-9584-a24975790203'
const CONTENT = process.argv[3] ?? '你好，简单回复我一句'

// 1. 打开 SSE 流
const req = http.get(`${BASE}/chatapi/events`, (res) => {
  let buf = ''
  res.on('data', (chunk) => {
    buf += chunk.toString()
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const line = raw.replace(/^data: /, '')
      if (line.startsWith(':') || line === '') continue
      try {
        const frame = JSON.parse(line)
        const { event, data } = frame
        if (event === 'message.stream') {
          const d = data
          if (d.done) console.log(`[SSE] ${event} done  messageId=${d.messageId} conv=${d.conversationId}`)
          else console.log(`[SSE] ${event} delta(${d.reasoning ? 'R' : 'T'})="${d.delta}"`)
        } else if (event === 'message.created') {
          console.log(`[SSE] ${event} id=${data.id} conv=${data.conversation_id} content="${String(data.content).slice(0, 30)}"`)
        } else {
          console.log(`[SSE] ${event}`, JSON.stringify(data).slice(0, 120))
        }
      } catch {
        console.log('[SSE] unparsed:', line)
      }
    }
  })
  res.on('end', () => console.log('[SSE] closed'))
})

req.on('error', (e) => console.error('[SSE] error', e.message))

// 2. 等 SSE 建立后发消息
setTimeout(async () => {
  console.log('[SEND] content =', CONTENT)
  try {
    const r = await fetch(`${BASE}/chatapi/bots/${BOT}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: CONTENT }),
    })
    console.log('[SEND] resp', r.status)
  } catch (e) {
    console.error('[SEND] error', e.message)
  }
}, 1500)

// 3. 30 秒后退出
setTimeout(() => process.exit(0), 30000)
