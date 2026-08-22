/**
 * Keyless HTML-scraping search engines for the chat composite provider:
 * DuckDuckGo Lite (primary free route) and Bing (final fallback). Both are
 * best-effort — public endpoints, no API key, subject to rate limiting; the
 * composite provider degrades gracefully when they fail.
 *
 * @module @deepseek-ai/dsh-chat-web-search/scrapers
 */

import type { WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 15_000
const MAX_SNIPPET_LENGTH = 500

/** Decode the handful of entities that appear in scraped titles/snippets. */
function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&ensp;|&emsp;/g, ' ')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** Unwrap DDG's `duckduckgo.com/l/?uddg=<url>` redirect links. */
function unwrapDdgRedirect(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com')
    if (url.pathname === '/l/') {
      const target = url.searchParams.get('uddg')
      if (target !== null && target.length > 0) return decodeURIComponent(target)
    }
    return url.toString()
  } catch {
    return href
  }
}

/** Fetch one HTML page as text; any failure rejects. */
async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  const onOuterAbort = (): void => controller.abort()
  signal?.addEventListener('abort', onOuterAbort, { once: true })
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** Truncate a snippet for the model-facing surface. */
function clip(text: string): string {
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text
}

/**
 * DuckDuckGo Lite (`lite.duckduckgo.com/lite/?q=`): a minimal server-rendered
 * table where each result row is `<a class="result-link" href>` followed by a
 * `<td class="result-snippet">`. No key, no JS.
 */
export async function duckDuckGoSearch(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
  const html = await fetchHtml(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, signal)
  const sources: WebSearchSource[] = []

  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g
  const snippets: string[] = []
  for (const match of html.matchAll(snippetRe)) snippets.push(decodeEntities(match[1] ?? ''))

  for (const match of html.matchAll(linkRe)) {
    const url = unwrapDdgRedirect(match[1] ?? '')
    const title = decodeEntities(match[2] ?? '')
    if (url.length === 0 || !/^https?:\/\//.test(url)) continue
    const snippet = snippets[sources.length] ?? ''
    sources.push({
      url,
      title,
      ...(snippet.length > 0 ? { snippet: clip(snippet) } : {}),
    })
  }

  if (sources.length === 0) throw new Error('duckduckgo lite returned no results')
  return { sources, truncated: false }
}

/**
 * Bing HTML (`www.bing.com/search?q=`): each organic hit is an
 * `<li class="b_algo">` block whose `<h2><a href>` is the link and the first
 * `<p>` in the caption is the snippet. No key; regional redirects are followed.
 */
export async function bingSearch(query: string, signal?: AbortSignal): Promise<WebSearchResult> {
  const html = await fetchHtml(
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&setmkt=zh-CN`,
    signal,
  )
  const sources: WebSearchSource[] = []

  const itemRe = /<li[^>]*class="b_algo"[^>]*>([\s\S]*?)<\/li>/g
  for (const item of html.matchAll(itemRe)) {
    const block = item[1] ?? ''
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (link === null) continue
    const url = decodeEntities(link[1] ?? '')
    const title = decodeEntities(link[2] ?? '')
    if (url.length === 0 || !/^https?:\/\//.test(url)) continue
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    const snippet = p === null ? '' : decodeEntities(p[1] ?? '')
    sources.push({
      url,
      title,
      ...(snippet.length > 0 ? { snippet: clip(snippet) } : {}),
    })
  }

  if (sources.length === 0) throw new Error('bing returned no results')
  return { sources, truncated: false }
}
