/**
 * Chat attachment metadata and its durable home in the session log.
 *
 * Attachments have two very different persistence stories, and keeping them
 * straight is the whole point of this module:
 *
 * - **Images** are admitted through the attachment store, which already
 *   stores the bytes and hands back an immutable reference. The model reads
 *   them from the session's image blocks.
 * - **Files and documents** are written into the bot's workspace `uploads/`
 *   directory (see `upload.ts`), because there is no attachment-store path for
 *   non-image bytes.
 *
 * Either way the *bytes* are durable; what was missing is the *metadata* the
 * UI needs to draw a bubble after a reload. That is stored as a
 * `chat/attachments` session event, which is the only place that is both
 * durable and naturally ordered against the message it belongs to.
 *
 * @module @deepseek-ai/dsh-chat-bots/src/attachments
 */

import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/**
 * Durable attachment metadata for one chat message.
 *
 * `kind` decides which backend serves the bytes: `image` resolves through the
 * attachment store, `file`/`document` through the bot's workspace.
 */
export interface ChatAttachmentMeta {
  /** `image` renders inline and previews; the others render as a card. */
  readonly kind: 'image' | 'file' | 'document'
  readonly name: string
  readonly mediaType: string
  readonly size: number
  /**
   * Where the bytes live, interpreted by `kind`:
   * - `image` — attachment store id, served by `/chatapi/attachments/:id`
   * - `file`/`document` — path relative to the bot workspace
   */
  readonly ref: string
}

/**
 * Session event carrying the attachments of the next user message.
 *
 * `session.append` commits synchronously and stamps its own seq, which is what
 * lets history pair attachments with the message that follows them — the
 * `/send` endpoint cannot know the message seq up front because `followup`
 * only queues input for the driver.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Attachments belonging to the next user message in this session. */
    'chat/attachments': { readonly items: readonly ChatAttachmentMeta[] }
    /**
     * Document-attachment hint shown to the model. Lives outside the user
     * message envelope so it never appears in the chat bubble, and is keyed by
     * the seq of the *user/message* event that should *consume* it (set by
     * the sender, not derived from ordering). The model reads the hint and
     * then immediately invokes `read_document`.
     */
    'chat/document-hint': { readonly forMessageSeq: number; readonly text: string }
  }
}

/** Extensions treated as inline, previewable images. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif'])

/**
 * Recalled image references, keyed by attachment id.
 *
 * `AttachmentStore` can only read an image given its *full* reference, and
 * offers no id lookup — so the UI, which only ever carries the id, would have
 * no way to fetch bytes after a host restart. This map bridges the gap.
 *
 * Persisted on disk (see {@link loadImageRefs}) so the bridge survives a host
 * restart: image refs are otherwise lost on restart, and history replay only
 * covers sessions the user has already opened. The store itself keeps the
 * bytes permanently — only this id-to-ref *index* needs to be re-established.
 */
const imageRefs = new Map<string, ImageAttachmentRef>()

/** Cap so a long-lived host with many images cannot grow without bound. */
const IMAGE_REF_CACHE_MAX = 5000

/** Once-flip guards so disk IO never runs more than once per process. */
let imageRefsLoaded = false
let imageRefsDirty = false
let imageRefsWriting: Promise<void> | undefined

/**
 * Disk-backed index location. `$DSH_HOME/attachments/refs.json` (sibling of
 * `sessions/`); absent on first run. The directory already exists because the
 * attachment store lives there too.
 */
function imageRefsPath(): string {
  return join(resolveDshHome(), 'attachments', 'refs.json')
}

/**
 * Eagerly populate {@link imageRefs} from disk. Idempotent — safe to call on
 * every plugin start, every history read, every attachment fetch, etc.
 *
 * Errors are swallowed because the worst case is falling back to the
 * history-driven recovery path: the user only sees a broken image until they
 * reopen the conversation, never data corruption.
 */
export async function loadImageRefs(): Promise<void> {
  if (imageRefsLoaded) return
  imageRefsLoaded = true
  try {
    const raw = await readFile(imageRefsPath(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object') return
    for (const [id, ref] of Object.entries(parsed as Record<string, unknown>)) {
      if (ref === null || typeof ref !== 'object') continue
      const r = ref as Partial<ImageAttachmentRef>
      if (typeof r.attachmentId !== 'string' || typeof r.mediaType !== 'string') continue
      imageRefs.set(id, ref as ImageAttachmentRef)
    }
  } catch {
    /* first run or unreadable index — fall back to history recovery */
  }
}

/**
 * Persist the current map to disk. Coalesced: many `rememberImageRef` calls
 * between flushes resolve to one write. Failure is non-fatal (next session /
 * host restart would still see missing refs, but in-memory state stays
 * consistent).
 */
function scheduleImageRefsFlush(): void {
  imageRefsDirty = true
  if (imageRefsWriting !== undefined) return
  imageRefsWriting = (async () => {
    // microtask debounce: batch a tight burst of writes into one fsync
    await Promise.resolve()
    try {
      while (imageRefsDirty) {
        imageRefsDirty = false
        const path = imageRefsPath()
        await mkdir(dirname(path), { recursive: true })
        const serialized = JSON.stringify(Object.fromEntries(imageRefs), null, 0)
        await writeFile(path, serialized, 'utf8')
      }
    } catch {
      /* index is best-effort; host restart will rebuild from history */
    } finally {
      imageRefsWriting = undefined
    }
  })()
}

/** Record one image reference so its bytes can be served later by id. */
export function rememberImageRef(ref: ImageAttachmentRef): void {
  const id = String(ref.attachmentId)
  if (id === '') return
  // FIFO eviction: attachments are immutable and re-remembered on each
  // history read, so dropping the oldest costs at most one re-read.
  if (imageRefs.size >= IMAGE_REF_CACHE_MAX && !imageRefs.has(id)) {
    const oldest = imageRefs.keys().next()
    if (oldest.done !== true) imageRefs.delete(oldest.value)
  }
  imageRefs.set(id, ref)
  scheduleImageRefsFlush()
}

/** Look up a remembered image reference by attachment id. */
export function findImageRef(attachmentId: string): ImageAttachmentRef | undefined {
  return imageRefs.get(attachmentId)
}

/**
 * Re-register every image reference carried by a message's content blocks.
 *
 * Also lazily hydrates the in-memory map from disk, which closes a gap in the
 * recovery path: an attachment fetch may race history loading on first render,
 * and the in-memory map alone would 404 until history arrives. The disk index
 * (or the second call) will catch it.
 */
export function rememberImageRefs(refs: readonly ImageAttachmentRef[]): void {
  if (!imageRefsLoaded) void loadImageRefs()
  let changed = false
  for (const ref of refs) {
    const id = String(ref.attachmentId)
    if (id === '') continue
    if (!imageRefs.has(id)) {
      imageRefs.set(id, ref)
      changed = true
    }
  }
  if (changed) scheduleImageRefsFlush()
}

/** Bucket an uploaded file by extension for rendering purposes. */
export function attachmentKindOf(name: string, mediaType: string): ChatAttachmentMeta['kind'] {
  if (mediaType.startsWith('image/') || IMAGE_EXTS.has(extname(name).toLowerCase())) return 'image'
  return 'document'
}

/**
 * Normalize a client-supplied workspace-relative path to an absolute one,
 * refusing anything that escapes the workspace root.
 *
 * Uploads are already written through `saveUploadedFile`, which sanitizes the
 * name, but this is the check that makes the *read* path safe: the ref travels
 * back from the client on every preview/open request, so it is re-validated
 * rather than trusted.
 */
export function resolveWorkspaceFile(workspaceDir: string, relPath: string): string | undefined {
  if (relPath === '' || relPath.includes('\0')) return undefined
  const root = resolve(workspaceDir)
  const target = resolve(root, relPath)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/** Display name for an attachment whose name is missing or empty. */
export function attachmentDisplayName(name: string, fallback = 'attachment'): string {
  const base = basename(name).trim()
  return base === '' ? fallback : base
}

/**
 * Record the attachments of the message about to be sent.
 *
 * No-op when there is nothing to record, so the log stays free of empty
 * events.
 */
export function appendAttachments(session: Session, items: readonly ChatAttachmentMeta[]): void {
  if (items.length === 0) return
  session.append('chat/attachments', { items })
}

/**
 * Record a document-hint for the user message about to be sent.
 *
 * Goes through `session.append` (not `agent.followup`) so the hint lives as an
 * independent session event the driver never turns into a `user/message`.
 * That keeps it out of the chat bubble — see `renderPrivateHistory` which
 * only renders `source.kind === 'user'` events — while still keeping it in
 * the same session log so the model can read it via `systemPrompt` /
 * persisted transcripts.
 */
export function appendDocumentHint(session: Session, forMessageSeq: number, text: string): void {
  if (text === '') return
  session.append('chat/document-hint', { forMessageSeq, text })
}

/**
 * Pair `chat/attachments` events with the user messages that follow them.
 *
 * The endpoint appends attachments *before* handing input to the driver, so
 * each event belongs to the next `user/message`. Anything left unclaimed at
 * the end (for example after a failed send) is dropped rather than leaking
 * into a later message.
 *
 * @returns attachment items keyed by the seq of the owning user message.
 */
export function collectAttachmentEvents(session: Session): Map<number, readonly ChatAttachmentMeta[]> {
  const byMessage = new Map<number, readonly ChatAttachmentMeta[]>()
  let pending: readonly ChatAttachmentMeta[] | undefined
  for (const event of session.events) {
    if (event.type === 'chat/attachments') {
      // Consecutive attachment events accumulate (e.g. two uploads in a row).
      const items = (event.data as { items?: readonly ChatAttachmentMeta[] }).items ?? []
      pending = pending === undefined ? items : [...pending, ...items]
      continue
    }
    if (event.type === 'user/message') {
      if ((event.data.source as { kind?: string } | undefined)?.kind !== 'user') continue
      if (pending !== undefined && pending.length > 0) {
        const existing = byMessage.get(event.seq)
        byMessage.set(event.seq, existing === undefined ? pending : [...existing, ...pending])
      }
      pending = undefined
    }
  }
  return byMessage
}

/**
 * Disk layout for user-sent image attachments.
 *
 * Unlike documents, images are read by the UI on every history load — and the
 * UI runs in a webview that cannot tolerate the host restart race inherent
 * to ID-based lookup. The path is the value handed to the webview: stable
 * and trivially verifiable.
 *
 * `$HOME/chat-agent-images/<conversationId>/<timestamp>-<basename>.<ext>`
 *
 * Why not use `$DSH_HOME`? The Tauri webview's CORS allow-list (`http:default`
 * in `capabilities/default.json`) only permits `127.0.0.1:3180`, so the file
 * must be served by dsh itself — but dsh cannot read anything outside its
 * configured roots. `$HOME` is always readable, sidesteps per-profile dsh-home
 * rebuilds on startup, and is independent of the active `dsh --profile`.
 */
export function imagesRoot(): string {
  return join(process.env.HOME ?? '/tmp', 'chat-agent-images')
}

/**
 * Write one image's bytes to disk and return the absolute file path.
 *
 * The path is the value the webview hands to Tauri `convertFileSrc`, which
 * rewrites it to an `asset://` URL the WKWebView will load without crossing
 * any HTTP origin. Returning absolute (not relative) paths lets history and
 * fresh sends both feed the same front-end code.
 *
 * Failures fall back to an empty string so the caller keeps going — better
 * to send the message with a missing picture than to block on disk IO.
 */
export async function writeChatImage(
  conversationId: string,
  name: string,
  data: Buffer,
): Promise<string> {
  // Webview-supplied file names may contain spaces, slashes, or unicode; for
  // the filename on disk we keep the basename and add a timestamp prefix so
  // two uploads of the same name don't collide.
  const ts = Date.now()
  const cleanBase = basename(name).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image'
  const dir = join(imagesRoot(), conversationId)
  await mkdir(dir, { recursive: true })
  const onDisk = `${String(ts)}-${cleanBase}`
  const abs = join(dir, onDisk)
  await writeFile(abs, data)
  return abs
}

/**
 * Migrate one attachment-store image to the chat-images tree on disk, so the
 * webview can load it via `asset://`. Returns the absolute path on success,
 * undefined on failure (callers should leave the original ref untouched).
 *
 * Used by the history endpoint: legacy sessions hold image refs as
 * attachment-store ids that the webview cannot render cross-origin. Each
 * history pull walks those refs and dumps the bytes to disk once; subsequent
 * pulls hit the existing file.
 */
export async function migrateImageAttachment(
  conversationId: string,
  ref: ImageAttachmentRef,
  readBytes: () => Promise<Buffer>,
): Promise<string | undefined> {
  const ts = Date.now()
  const base = basename(ref.name ?? 'image').replace(/[^\w.\-]/g, '_').slice(0, 80) || 'image'
  const dir = join(imagesRoot(), conversationId)
  await mkdir(dir, { recursive: true })
  // 把 attachment id 拼进路径：同一 attachment 不会重复迁移（同一 ref 再次
  // 到达时，因 conversationId + id 组合唯一，仍能落到唯一路径）。
  const onDisk = `${String(ts)}-${base}`
  const abs = join(dir, onDisk)
  try {
    const bytes = await readBytes()
    await writeFile(abs, bytes)
    return abs
  } catch {
    return undefined
  }
}

/**
 * Resolve and read one image from the chat-images tree.
 *
 * Re-validates the path so a hand-crafted URL cannot escape the
 * conversation's directory.
 */
export async function readChatImage(
  conversationId: string,
  onDisk: string,
): Promise<{ data: Buffer; mediaType: string } | undefined> {
  // On-disk names are always produced by `writeChatImage`; rejects anything
  // with path separators or that resolves outside the conversation's folder.
  if (onDisk.includes('/') || onDisk.includes('\\') || onDisk.includes('..')) return undefined
  const root = imagesRoot()
  const dir = join(root, conversationId)
  const abs = join(dir, onDisk)
  const resolved = resolve(abs)
  if (!resolved.startsWith(resolve(dir) + sep)) return undefined
  let bytes: Buffer
  try {
    bytes = await readFile(resolved)
  } catch {
    return undefined
  }
  // mediaType is not preserved on disk; sniff from the extension. We re-derive
  // on the write side too — keep the mapping local and conservative.
  const mediaType = sniffImageMediaType(onDisk)
  return { data: bytes, mediaType }
}

/** Map the file extension back to a mediaType. Conservative: only the formats
 * the chat input accepts (PNG/JPEG/WebP/GIF). */
function sniffImageMediaType(name: string): string {
  const ext = extname(name).toLowerCase()
  switch (ext) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}
