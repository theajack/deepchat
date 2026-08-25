// 诊断：加载 profile 组合后列出每个 loader entry 的 fiber 状态，
// 定位 chat-bots 为何没注册出 chatBots 服务。
import { boot } from '@deepseek-ai/dsh-app-boot'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]!
const configPath = resolve(root, 'config.yaml')
const patches = JSON.parse(readFileSync(process.argv[3]!, 'utf8'))

const ctx = await boot('diag', configPath, patches)
const loader = ctx.get('loader')
for (const entry of loader.entries()) {
  const fiber = entry.fiber
  const state = fiber === undefined ? 'NO-FIBER' : fiber.state
  const missing = fiber === undefined ? [] : Object.keys(fiber.inject ?? {}).filter(s => fiber.ctx?.get(s) === undefined)
  console.log(`${entry.options.name}: state=${String(state)} missing=[${missing.join(',')}] disabled=${Boolean(entry.disabled)}`)
  if (state === 'FAILED') {
    try { await fiber.await() } catch (e) { console.log('  ERROR:', e) }
  }
}
console.log('chatBots service:', ctx.get('chatBots'))
await ctx.dispose()
process.exit(0)
