/**
 * Local-image avatar handling: parse a dataURL from the client, write it to
 * `<botDir>/avatar.<ext>`, and produce the relative URL the webview can fetch
 * back via `/chatapi/avatars/:id`.
 *
 * @module @deepseek-ai/dsh-chat-bots/avatar
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
}

const MAX_BYTES = 8 * 1024 * 1024

export interface ParsedAvatar {
  readonly ext: string
  readonly bytes: Buffer
}

/** Parse a `data:image/<type>;base64,...` string into a writable payload. */
export function parseDataUrl(input: string): ParsedAvatar {
  const match = /^data:(image\/[a-zA-Z+-]+);base64,(.+)$/.exec(input)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error('avatar 必须为 dataURL 格式（image/*;base64,...）')
  }
  const mime = match[1].toLowerCase()
  const ext = MIME_TO_EXT[mime]
  if (ext === undefined) throw new Error(`不支持的头像格式: ${mime}`)
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.byteLength === 0) throw new Error('头像数据为空')
  if (bytes.byteLength > MAX_BYTES) throw new Error('头像过大（上限 8MB）')
  return { ext, bytes }
}

/** Write a parsed avatar to `<botDir>/avatar.<ext>`; returns the relative URL
 *  the webview can use as an `<img src>`. */
export async function writeBotAvatar(botDir: string, dataUrl: string): Promise<{ avatar: string; ext: string }> {
  const parsed = parseDataUrl(dataUrl)
  await mkdir(botDir, { recursive: true })
  // 清旧头像（不同扩展名都可能残留）
  for (const oldExt of Object.values(MIME_TO_EXT)) {
    await rm(join(botDir, `avatar.${oldExt}`), { force: true }).catch(() => {})
  }
  await writeFile(join(botDir, `avatar.${parsed.ext}`), parsed.bytes)
  const botId = botDir.split('/').pop() ?? ''
  return { avatar: `/chatapi/avatars/${encodeURIComponent(botId)}/avatar.${parsed.ext}`, ext: parsed.ext }
}
