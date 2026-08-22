/**
 * Register the chat composite search provider in `ctx.web`: DeepSeek native
 * search when the Models-page `DEEPSEEK_API_KEY` credential exists, keyless
 * DuckDuckGo Lite otherwise, Bing HTML as the final fallback. Replaces the
 * bundle's stock `web-search-deepseek` row for the chat profile.
 *
 * @module @deepseek-ai/dsh-chat-web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  DEEPSEEK_DEFAULT_API_VERSION,
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_DEFAULT_MAX_TOKENS,
  DEEPSEEK_DEFAULT_MAX_USES,
  DEEPSEEK_DEFAULT_MODEL,
} from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import { ChatCompositeSearchProvider } from './provider.ts'

export { ChatCompositeSearchProvider, CHAT_SEARCH_PROVIDER_ID } from './provider.ts'
export { bingSearch, duckDuckGoSearch } from './scrapers.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chat-web-search'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Credential reference the DeepSeek leg resolves per search. */
const DEEPSEEK_KEY = credentialRef('DEEPSEEK_API_KEY')

/**
 * Resolve the DeepSeek leg's options. Key lookup mirrors the stock plugin:
 * credentials service first (what the Models page writes through the chat-bots
 * mirror), then the launching environment.
 */
function resolveDeepSeekOptions(ctx: Context): DeepSeekSearchProviderOptions {
  return {
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(DEEPSEEK_KEY))?.value
      const ambient = process.env.DEEPSEEK_API_KEY
      return ambient !== undefined && ambient.length > 0 ? ambient : undefined
    },
    apiKeyEnv: DEEPSEEK_KEY,
    baseURL: process.env.DEEPSEEK_SEARCH_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL,
    model: DEEPSEEK_DEFAULT_MODEL,
    apiVersion: DEEPSEEK_DEFAULT_API_VERSION,
    maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
    maxUses: DEEPSEEK_DEFAULT_MAX_USES,
  }
}

/** Register the composite provider with `ctx.web`. */
export function apply(ctx: Context): void {
  ctx.web.registerSearchProvider(new ChatCompositeSearchProvider(() => resolveDeepSeekOptions(ctx)))
}
