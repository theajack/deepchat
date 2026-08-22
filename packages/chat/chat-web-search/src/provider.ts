/**
 * The composite chat search provider: DeepSeek native search first (reuses the
 * `DEEPSEEK_API_KEY` the Models page manages — new users get full server-side
 * retrieval the moment a key is saved), keyless DuckDuckGo Lite when no key
 * exists or the DeepSeek leg fails, and Bing HTML as the last keyless fallback.
 * Always `available()` — search never hard-fails for lack of a credential.
 *
 * @module @deepseek-ai/dsh-chat-web-search/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'
import { DeepSeekSearchProvider } from '@deepseek-ai/dsh-web-search-deepseek'
import type { DeepSeekSearchProviderOptions } from '@deepseek-ai/dsh-web-search-deepseek'
import { bingSearch, duckDuckGoSearch } from './scrapers.ts'

/** Stable id this provider registers under (pin it in the web seam config). */
export const CHAT_SEARCH_PROVIDER_ID = 'chat-search'

/** Attribution header for the scraping legs. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * The composite provider. The DeepSeek leg is a private `DeepSeekSearchProvider`
 * instance whose options are snapshotted per search through the injected
 * resolver, so Models-page key edits apply on the next search without
 * re-registration.
 */
export class ChatCompositeSearchProvider implements WebSearchProvider {
  readonly id = CHAT_SEARCH_PROVIDER_ID

  constructor(private readonly resolveDeepSeekOptions: () => DeepSeekSearchProviderOptions) {}

  /** Always usable: the keyless legs carry no credential requirement. */
  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // Leg 1: DeepSeek native search — only when a key is resolvable, so the
    // missing-credential WebError never even surfaces for keyless users.
    const deepseek = new DeepSeekSearchProvider(this.resolveDeepSeekOptions)
    if (deepseek.available()) {
      try {
        return await deepseek.search(request, signal)
      } catch (error: unknown) {
        // Abort is a contract, not a degradation trigger.
        if (signal?.aborted === true || (error instanceof WebError && error.code === 'WEB_ABORTED')) throw error
        // Missing credential raced in between snapshot and resolution: fall
        // through to the keyless legs. Any other DeepSeek failure (network,
        // HTTP, malformed body) also degrades rather than failing the tool.
      }
    }

    // Leg 2: DuckDuckGo Lite (keyless, no JS).
    try {
      return await duckDuckGoSearch(request.query, signal)
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('chat search aborted', 'WEB_ABORTED', { cause: error })
      }
    }

    // Leg 3: Bing HTML (keyless final fallback).
    try {
      return await bingSearch(request.query, signal)
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new WebError('chat search aborted', 'WEB_ABORTED', { cause: error })
      }
      throw new WebError(
        `all keyless search engines failed for query "${request.query}": ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }
}

/** Re-exported so callers can join the attribution constant. */
export const CHAT_SEARCH_USER_AGENT = USER_AGENT
