// 诊断：禁用 chat-group 后组合加载 chat-agent profile，列出每个 loader entry
// 的 fiber 状态，定位 chatBots 服务为何未注册。
import { runProfile } from '../apps/cli/src/profile-boot.ts'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'

const patchFile = process.argv[2]

const { ctx } = await runProfile({
  environment: loadLayeredEnv('dsh'),
  profile: 'chat-agent',
  patchFiles: patchFile !== undefined ? [patchFile] : [],
  args: [],
})

const loader = ctx.get('loader')!
for (const entry of loader.entries()) {
  const fiber = entry.fiber
  const state = fiber === undefined ? 'NO-FIBER' : String(fiber.state)
  const disabled = Boolean(entry.disabled)
  const missing = fiber === undefined ? [] : Object.keys(fiber.inject).filter(s => fiber.ctx.get(s) === undefined)
  console.log(`${entry.options.name}: state=${state} disabled=${disabled} missing=[${missing.join(',')}]`)
  if (fiber !== undefined && fiber.state === 2) {
    try { await fiber.await() } catch (e) { console.log('  ERROR:', e) }
  }
}
console.log('chatBots service:', ctx.get('chatBots')?.constructor?.name)
process.exit(0)
