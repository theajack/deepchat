/**
 * Persisting binary chat attachments into a bot's workspace.
 *
 * Text files ride along inside the message body, but binary ones (Office
 * documents, PDFs) cannot — they have to land on disk first so the model can
 * reach them with `read_document`. The upload therefore writes into the bot's
 * own workspace, which is also the agent's cwd, so the returned relative path
 * is directly usable.
 *
 * @module @deepseek-ai/dsh-chat-bots/src/upload
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'

/** Subdirectory of the bot workspace that holds user uploads. */
const UPLOAD_DIR = 'uploads'

/** Largest accepted upload. Matches the 10MB gate the UI applies first. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/**
 * Extensions accepted for upload.
 *
 * Binary documents mirror `read_document`'s `SUPPORTED_FORMATS` — storing a
 * binary the model cannot read back would be pointless. Plain-text types are
 * additionally accepted: their content is already inlined into the message,
 * but landing them on disk too gives every attachment the same "click to open
 * with the system handler" behaviour in the chat bubble.
 */
const ALLOWED_EXTS = new Set([
  '.docx', '.xlsx', '.pptx', '.pdf',
  '.txt', '.md', '.json', '.csv', '.log', '.yml', '.yaml', '.toml',
  '.xml', '.html', '.css', '.js', '.ts', '.py', '.go', '.rs', '.java', '.sh', '.sql',
])

/** Characters that break paths or shell out — replaced in uploaded names. */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

export interface UploadedFile {
  /** Path relative to the bot workspace (the agent's cwd). */
  relPath: string
  /** Final file name on disk — may be suffixed to avoid clobbering. */
  name: string
  size: number
}

export interface UploadFailure {
  error: string
}

/**
 * Strip directory components and unsafe characters from a client-supplied
 * file name.
 *
 * The name arrives from the UI and is attacker-influenced in principle, so it
 * is reduced to a bare base name before it ever touches the filesystem — this
 * is what neutralises `../` traversal and absolute-path injection.
 */
export function sanitizeFileName(name: string): string {
  // 顺序有意为之：先 basename 剥掉目录成分（挡住 ../../ 与绝对路径），
  // 再替换非法字符，最后把连续的点折叠掉——否则 `..\..\evil.xlsx` 会变成
  // `.._.._evil.xlsx`，虽然仍困在 uploads 目录内，但名字里带 `..` 容易被
  // 其他按字符串判断路径的工具误读。
  const base = basename(name)
    .replace(UNSAFE_NAME_CHARS, '_')
    .replace(/\.{2,}/g, '_')
    .trim()
  // basename() of "..", "." or "/" yields an empty or dotted result; reject it
  // rather than writing a file the model could never name back.
  return base === '' || base === '.' || base === '..' ? '' : base
}

/**
 * Save one uploaded attachment into `<workspaceDir>/uploads/`.
 *
 * Writes to a temporary name first, then renames into place, so a crash
 * mid-write can never leave a truncated file that `read_document` would later
 * fail to parse. Existing files are not overwritten: `报告.xlsx` becomes
 * `报告-1.xlsx`, keeping earlier uploads (and any references to them) intact.
 */
export async function saveUploadedFile(
  workspaceDir: string,
  rawName: string,
  base64: string,
): Promise<UploadedFile | UploadFailure> {
  const ext = extname(rawName).toLowerCase()
  if (!ALLOWED_EXTS.has(ext)) {
    return { error: `不支持的文件类型 ${ext || '(无扩展名)'}，仅支持 ${[...ALLOWED_EXTS].join(' / ')}` }
  }

  const safe = sanitizeFileName(rawName)
  if (safe === '') return { error: '文件名不合法' }

  let bytes: Buffer
  try {
    bytes = Buffer.from(base64, 'base64')
  } catch {
    return { error: '文件内容不是合法的 base64' }
  }
  if (bytes.byteLength === 0) return { error: '文件内容为空' }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return { error: `文件过大（${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB），上限 ${String(MAX_UPLOAD_BYTES / 1024 / 1024)}MB` }
  }

  const target = resolve(workspaceDir, UPLOAD_DIR)
  await mkdir(target, { recursive: true })

  const stem = safe.slice(0, safe.length - extname(safe).length)
  let candidate = safe
  let counter = 1
  // Avoid clobbering: keep bumping a suffix until the name is free.
  while (true) {
    const probe = resolve(target, candidate)
    if (!probe.startsWith(target + sep)) return { error: '文件名不合法' }
    try {
      await writeFile(probe, bytes, { flag: 'wx' }) // fail if exists
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code
      if (code === 'EEXIST') {
        candidate = `${stem}-${String(counter)}${ext}`
        counter += 1
        continue
      }
      return { error: '写入文件失败' }
    }
    break
  }

  return {
    relPath: join(UPLOAD_DIR, candidate),
    name: candidate,
    size: bytes.byteLength,
  }
}
