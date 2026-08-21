import { marked } from 'marked'
import hljs from 'highlight.js'
import 'highlight.js/styles/github-dark.css'
import { t } from '../i18n'

// ============ 非流式渲染（最终消息） ============

export function renderMarkdown(raw: string): string {
  if (!raw) return ''
  const html = marked.parse(raw, { async: false }) as string
  return wrapCodeBlocks(html)
}

// ============ 流式渲染（分段缓存） ============

/**
 * 段级 LRU 缓存：key = 段原文，value = 渲染后 HTML。
 * 完成的段命中缓存直接复用；只有最后一段（正在流式追加）每次重新渲染。
 */
const segmentCache = new Map<string, string>()
const MAX_CACHE = 300

function cacheGet(key: string): string | undefined {
  const v = segmentCache.get(key)
  if (v !== undefined) {
    segmentCache.delete(key)
    segmentCache.set(key, v) // 移到末尾（LRU）
  }
  return v
}

function cacheSet(key: string, value: string): void {
  if (segmentCache.size >= MAX_CACHE) {
    const first = segmentCache.keys().next().value
    if (first !== undefined) segmentCache.delete(first)
  }
  segmentCache.set(key, value)
}

/** 流式分段渲染：将内容拆为独立的段落/代码块，已完成段走缓存，仅末段实时渲染 */
export function renderMarkdownStreamed(raw: string): string {
  if (!raw) return ''
  const segments = splitSegments(raw)
  let html = ''
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const isLast = i === segments.length - 1
    if (!isLast) {
      const cached = cacheGet(seg)
      if (cached !== undefined) {
        html += cached
        continue
      }
    }
    const segHtml = renderSegment(seg, isLast)
    cacheSet(seg, segHtml)
    html += segHtml
  }
  return html
}

/**
 * 将原始 Markdown 拆分为可独立渲染的段：
 * - 代码块（``` ... ```）作为独立段
 * - 文本按空行分割为独立段落
 * 未闭合的代码块作为最后一段保留（renderSegment 会补全）
 */
function splitSegments(raw: string): string[] {
  const segments: string[] = []
  const lines = raw.split('\n')
  let buf = ''
  let inCode = false

  const flushText = () => {
    const trimmed = buf.trim()
    if (!trimmed) {
      buf = ''
      return
    }
    const paras = trimmed.split(/\n{2,}/)
    for (const p of paras) {
      const t = p.trim()
      if (t) segments.push(t + '\n\n')
    }
    buf = ''
  }

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const isFence = /^\s*```/.test(line)

    if (isFence && !inCode) {
      flushText()
      buf = line + '\n'
      inCode = true
    } else if (isFence && inCode) {
      buf += line + '\n'
      segments.push(buf)
      buf = ''
      inCode = false
    } else {
      buf += line + '\n'
    }
  }

  if (inCode) {
    segments.push(buf) // 未闭合代码块
  } else {
    flushText()
  }

  return segments
}

function renderSegment(seg: string, isLast: boolean): string {
  const fences = seg.match(/```/g)
  const isUnclosedCode = !!fences && fences.length % 2 !== 0

  const toParse = isUnclosedCode ? seg + '\n```' : seg
  const html = marked.parse(toParse, { async: false }) as string

  // 未闭合代码块（末段）跳过高亮，避免每帧都跑 highlightAuto
  if (isUnclosedCode && isLast) {
    return wrapCodeBlocksLite(html)
  }
  return wrapCodeBlocks(html)
}

// ============ 代码块后处理 ============

const CODE_READER = /<pre><code(?:\s+class="language-([^"]*)")?\s*>([\s\S]*?)<\/code><\/pre>/gi

function wrapCodeBlocks(html: string): string {
  return html.replace(CODE_READER, (_, lang: string | undefined, code: string) => {
    const decoded = decodeHtmlEntities(code)
    const langName = (lang || '').trim()

    let highlighted: string
    let displayLang = langName
    try {
      if (langName && hljs.getLanguage(langName)) {
        highlighted = hljs.highlight(decoded, { language: langName }).value
      } else {
        const auto = hljs.highlightAuto(decoded)
        highlighted = auto.value
        if (!displayLang && auto.language) displayLang = auto.language
      }
    } catch {
      highlighted = escapeHtml(decoded)
    }

    return buildCodeBlockWrapper(displayLang, decoded, highlighted)
  })
}

/** 轻量版：不做语法高亮，仅转义 + 包裹，用于流式末段的未闭合代码块 */
function wrapCodeBlocksLite(html: string): string {
  return html.replace(CODE_READER, (_, lang: string | undefined, code: string) => {
    const decoded = decodeHtmlEntities(code)
    const langName = (lang || '').trim()
    return buildCodeBlockWrapper(langName, decoded, escapeHtml(decoded))
  })
}

function buildCodeBlockWrapper(lang: string, code: string, highlighted: string): string {
  const langLabel = lang
    ? `<span class="code-lang-label">${escapeHtml(lang)}</span>`
    : '<span class="code-lang-label text-lo">text</span>'
  return [
    '<div class="code-block-wrapper">',
    `<div class="code-block-header">${langLabel}<span class="text-[11px] text-lo">${t('code.lines', { count: countLines(code) })}</span></div>`,
    `<pre class="code-block-body"><code class="hljs">${highlighted}</code></pre>`,
    '</div>',
  ].join('')
}

// ============ 工具函数 ============

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function countLines(str: string): number {
  let n = 1
  for (let i = 0; i < str.length; i++) if (str[i] === '\n') n++
  return n
}
