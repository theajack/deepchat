/**
 * The model-facing `read_document` tool: extract the text of an Office
 * document (docx/xlsx/pptx) or a PDF.
 *
 * The existing `read` tool decodes text files and rejects anything binary, so
 * without this the model has no way to look inside an attachment beyond its
 * filename. Parsing is delegated to `officeparser`, which covers all four
 * formats with one dependency and renders spreadsheets and tables as text
 * (TSV / Markdown) instead of a raw XML dump.
 *
 * Two constraints shape the implementation:
 *
 * 1. **Legacy binary Office formats are not supported.** doc/xls/ppt predate
 *    OOXML and no maintained pure-JS parser exists for them (the .ppt case is
 *    especially bleak — the ecosystem is abandoned). Rather than failing with
 *    an opaque error, these are detected by extension and refused with an
 *    actionable "save as" message.
 * 2. **A large document would otherwise swallow the whole context window.**
 *    Output is windowed (`offset` + `max_chars`) and every truncated read
 *    reports the total length so the model can page through deliberately.
 *
 * @module @deepseek-ai/dsh-chat-bots/src/read-document
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
// Side-effect type import: pulls in the `fs` Context augmentation.
import type {} from '@deepseek-ai/dsh-fs'
import { OfficeParser } from 'officeparser'

/**
 * Extensions `read_document` accepts, mapped to the parser's format hint.
 *
 * Passing the hint explicitly is what lets us hand the parser a Buffer: it
 * skips magic-byte sniffing, which cannot distinguish OOXML subtypes and is
 * unreliable for text-derived formats.
 */
const SUPPORTED_FORMATS: Readonly<Record<string, 'docx' | 'xlsx' | 'pptx' | 'pdf'>> = {
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.pdf': 'pdf',
}

/**
 * Legacy binary Office extensions, mapped to the modern equivalent to name in
 * the refusal. These are the pre-2007 formats; the parser does not read them.
 */
const LEGACY_FORMATS: Readonly<Record<string, string>> = {
  '.doc': '.docx',
  '.xls': '.xlsx',
  '.ppt': '.pptx',
}

/** Largest file handed to the parser. Past this the parse cost is not worth it. */
const MAX_FILE_BYTES = 50 * 1024 * 1024

/** Default characters returned per read; the model may raise or lower it. */
const DEFAULT_MAX_CHARS = 30_000

/** Ceiling on `max_chars`, so a single call cannot flood the context window. */
const MAX_CHARS_LIMIT = 200_000

/**
 * Bounds applied while inflating an OOXML/ODF archive.
 *
 * A hostile or corrupt document can encode a tiny ZIP that expands to
 * gigabytes. Real documents never approach these values, and the parser's own
 * defaults are far looser than this tool needs.
 */
const DECOMPRESSION_LIMITS = {
  maxUncompressedBytes: 256 * 1024 * 1024,
  maxZipEntries: 5_000,
} as const

/** The structured outcome declared by the `read_document` output schema. */
export interface DocumentReadValue {
  path: string
  /** Detected format, echoed back so a truncated read stays unambiguous. */
  format: string
  /** The extracted text window. */
  text: string
  /** Character offset this window starts at. */
  offset: number
  /** Total extracted characters, so the model knows how much remains. */
  totalChars: number
  /** True when the window stops before the end of the document. */
  truncated: boolean
}

/**
 * Provider resolution options for a model-facing read: the calling agent's
 * session cwd, so a bare filename resolves inside the bot's workspace, plus
 * the cancellation signal.
 */
function resolveOptions(exec: ToolExecution): { cwd?: string; signal?: AbortSignal } {
  const cwd = exec.agent?.session.header.cwd
  return {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  }
}

/**
 * Render one read as the model-facing envelope.
 *
 * The truncation notice is deliberately loud: a model that mistakes a window
 * for the whole document will answer confidently from partial data.
 */
function formatDocumentReadOutput(value: DocumentReadValue): string {
  const header = `<path>${value.path}</path>\n<type>${value.format}</type>`
  if (value.totalChars === 0) {
    return `${header}\n<content>\n(Document parsed successfully but contains no extractable text.)`
  }
  const range = value.offset > 0 || value.truncated
    ? ` <range>chars ${String(value.offset)}-${String(value.offset + value.text.length)} of ${String(value.totalChars)}</range>`
    : ''
  const notice = value.truncated
    ? `\n[Truncated: showing characters ${String(value.offset)}-${String(value.offset + value.text.length)} of ${String(value.totalChars)}. To read the remainder, call read_document again with offset=${String(value.offset + value.text.length)}.]`
    : ''
  return `${header}${range}\n<content>\n${value.text}${notice}`
}

/**
 * Register the `read_document` tool into the given context.
 *
 * Registration is scoped to the bot's agent context (see
 * `buildBotAgentSetup`), which keeps it outside the per-bot `enabledTools`
 * whitelist — a companion can always read its own attachments.
 *
 * Two contexts are needed on purpose. The tool *registers* into the agent's
 * context (`target`) so it stays scoped to that companion, but *reads files*
 * through the host plugin's context (`host`), because Cordis only exposes a
 * service to a context that declared it — and only the host plugin declares
 * `fs` in its `inject`. Reaching for `ctx.fs` on the agent context throws
 * `cannot get property "fs" without inject` the moment the tool first runs.
 * Both contexts resolve to the same filesystem service instance, so sandbox
 * and observation behaviour are unchanged.
 *
 * @param target - the agent context the tool registers into.
 * @param host - the plugin context that owns the `fs` service.
 */
export function registerReadDocumentTool(target: Context, host: Context): void {
  target.tools.register(defineTool({
    name: 'read_document',
    description: 'Extract the text content of an Office document or PDF (.docx, .xlsx, .pptx, .pdf). '
      + 'Use this instead of `read` for these formats — `read` only handles plain text and will reject binary files. '
      + 'Spreadsheets come back as tab-separated rows (one per sheet) and tables as Markdown. '
      + 'Long documents are returned in windows; when the result is truncated, call again with the suggested offset to continue.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the document, resolved by the filesystem backend. Relative paths resolve against the session workspace.',
      },
      offset: {
        type: 'integer',
        description: 'Character offset to start reading from. Defaults to 0. Use the offset named in a truncated result to continue.',
      },
      max_chars: {
        type: 'integer',
        description: `Maximum characters to return. Defaults to ${String(DEFAULT_MAX_CHARS)}, hard limit ${String(MAX_CHARS_LIMIT)}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true },
          text: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          totalChars: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatDocumentReadOutput(value) }],
    },
    // Reads never mutate, so independent documents may be parsed concurrently.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = args.file_path?.trim() ?? ''
      if (filePath === '') throw new Error('file_path must be a non-empty string')

      // Every format gate runs before any filesystem I/O so a refusal never
      // leaks a partial read.
      const extension = extname(filePath).toLowerCase()

      const legacyTarget = LEGACY_FORMATS[extension]
      if (legacyTarget !== undefined) {
        throw new Error(
          `cannot read "${filePath}": ${extension} is a legacy binary Office format and is not supported. `
          + `Re-save the file as ${legacyTarget} (Word/Excel/PowerPoint or WPS: File → Save As → ${legacyTarget}) and read the converted copy.`,
        )
      }

      const format = SUPPORTED_FORMATS[extension]
      if (format === undefined) {
        const supported = Object.keys(SUPPORTED_FORMATS).join(', ')
        throw new Error(
          `cannot read "${filePath}": read_document accepts ${supported} only. `
          + 'For plain text, code, JSON and similar, use the `read` tool instead.',
        )
      }

      const offset = args.offset ?? 0
      if (!Number.isInteger(offset) || offset < 0) throw new Error(`offset must be a non-negative integer, got ${String(args.offset)}`)
      const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS
      if (!Number.isInteger(maxChars) || maxChars <= 0) {
        throw new Error(`max_chars must be a positive integer, got ${String(args.max_chars)}`)
      }
      if (maxChars > MAX_CHARS_LIMIT) {
        throw new Error(`max_chars must not exceed ${String(MAX_CHARS_LIMIT)}, got ${String(maxChars)}`)
      }

      // 防御：fs 服务必须挂在宿主 context 上（靠宿主插件的 inject 声明）。
      // 缺失时给出可诊断的错误，而不是在下面撞上 undefined。
      if (host.fs === undefined || typeof host.fs.resolve !== 'function') {
        throw new Error(
          'read_document: 文件系统服务不可用（fs 未注入到宿主插件）。'
          + '请确认宿主插件的 inject 中声明了 "fs"。',
        )
      }

      const target = await host.fs.resolve(filePath, resolveOptions(exec))
      const info = await host.fs.stat(target, exec.signal)
      if (info === undefined) {
        host.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') {
        throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      if (info.size !== undefined && info.size > MAX_FILE_BYTES) {
        throw new FsError(
          `cannot read "${target.displayPath}": a ${(info.size / 1024 / 1024).toFixed(0)}MB file exceeds the ${String(MAX_FILE_BYTES / 1024 / 1024)}MB limit for document parsing`,
          'FS_TOO_LARGE',
        )
      }

      const data = await host.fs.readBytes(target, exec.signal, MAX_FILE_BYTES)
      host.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)

      let full: string
      try {
        const ast = await OfficeParser.parseOffice(data, {
          fileType: format,
          abortSignal: exec.signal ?? null,
          decompressionLimits: DECOMPRESSION_LIMITS,
        })
        full = (await ast.to('text')).value ?? ''
      } catch (error: unknown) {
        if (error instanceof Error && (error.name === 'AbortError' || exec.signal?.aborted === true)) throw error
        const reason = error instanceof Error ? error.message : String(error)
        throw new Error(`cannot parse "${target.displayPath}" as ${format}: ${reason}. The file may be corrupt, encrypted, or not actually a ${format} document despite its extension.`)
      }

      const totalChars = full.length
      const window = full.slice(offset, offset + maxChars)
      const value: DocumentReadValue = {
        path: target.displayPath,
        format,
        text: window,
        offset,
        totalChars,
        truncated: offset + window.length < totalChars,
      }
      return value
    },
    // Pure display: a generic card in the read family with a follow-along
    // location on the document.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read document ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
