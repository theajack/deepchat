/**
 * Remote skill catalog search (skills.sh) and GitHub skill installation.
 * Ported from the legacy chat-agent CLI skills module (`cli/src/skills`).
 *
 * @module @deepseek-ai/dsh-chat-bots
 */

import { randomBytes } from 'node:crypto'
import { exec } from 'node:child_process'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

const SEARCH_API_BASE = process.env.SKILLS_API_URL || 'https://skills.sh'
const SEARCH_RESULT_LIMIT = 20
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '__pycache__']
const MAX_DISCOVER_DEPTH = 5

/** One skills.sh catalog hit. */
export interface RemoteSkillHit {
  readonly name: string
  readonly slug: string
  readonly source: string
  readonly installs: number
}

/** Result shape shared by both install endpoints. */
export interface InstallResult {
  readonly installed: string[]
  readonly skipped: string[]
}

/** Strip ANSI escape sequences and trim (remote metadata is untrusted text). */
function sanitizeMetadata(value: string): string {
  return value.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim()
}

/** Human-readable install count, e.g. "1.2K installs". */
export function formatInstalls(count: number): string {
  if (!count || count <= 0) return ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`
  return `${count} install${count === 1 ? '' : 's'}`
}

/** Search the skills.sh registry; network failures resolve to an empty list. */
export async function searchSkillsApi(query: string, owner?: string): Promise<RemoteSkillHit[]> {
  try {
    const params = new URLSearchParams({ q: query, limit: String(SEARCH_RESULT_LIMIT) })
    if (owner !== undefined && owner !== '') params.set('owner', owner)
    const response = await fetch(`${SEARCH_API_BASE}/api/search?${params.toString()}`)
    if (!response.ok) return []
    const data = await response.json() as {
      skills: Array<{ id: string; name: string; installs: number; source: string }>
    }
    return data.skills
      .map(hit => ({
        name: sanitizeMetadata(hit.name),
        slug: sanitizeMetadata(hit.id),
        source: sanitizeMetadata(hit.source || ''),
        installs: hit.installs,
      }))
      .sort((a, b) => (b.installs || 0) - (a.installs || 0))
  } catch {
    return []
  }
}

// ── GitHub install ─────────────────────────────────────────────────────────

interface ParsedGithubSource {
  readonly url: string
  readonly skillFilter?: string
}

/**
 * Parse a GitHub source string:
 *   - owner/repo            → https://github.com/owner/repo.git
 *   - owner/repo@skill-name → same url + skill filter
 *   - https://github.com/owner/repo[.git]
 *   - https://github.com/owner/repo/tree/<ref>/path@skill
 */
export function parseGithubSource(source: string): ParsedGithubSource {
  let skillFilter: string | undefined
  let repoPart = source.trim()

  const atIdx = repoPart.lastIndexOf('@')
  if (atIdx > 0) {
    skillFilter = repoPart.slice(atIdx + 1).trim()
    repoPart = repoPart.slice(0, atIdx).trim()
  }

  let url: string
  if (/^https?:\/\//.test(repoPart)) {
    // strip tree/.../path segment for clone, keep url root
    const treeMatch = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/tree\/[^/]+/.exec(repoPart)
    if (treeMatch !== null) {
      url = `${treeMatch[1]}.git`
    } else {
      url = repoPart.endsWith('.git') ? repoPart : `${repoPart}.git`
    }
  } else if (/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(repoPart)) {
    url = `https://github.com/${repoPart}.git`
  } else {
    throw new Error(`无法识别的 GitHub 源: ${source}（示例: owner/repo 或 owner/repo@skill-name）`)
  }

  return { url, ...(skillFilter !== undefined ? { skillFilter } : {}) }
}

async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'SKILL.md'))).isFile()
  } catch {
    return false
  }
}

/** Recursively collect directories containing a SKILL.md. */
async function findSkillDirs(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DISCOVER_DEPTH) return []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    const children = await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && !SKIP_DIRS.includes(entry.name))
        .map(entry => findSkillDirs(join(dir, entry.name), depth + 1)),
    )
    return [
      ...(await hasSkillMd(dir) ? [dir] : []),
      ...children.flat(),
    ]
  } catch {
    return []
  }
}

/** Read one frontmatter field from a SKILL.md (line-level match; enough for name routing). */
async function frontmatterField(skillMdPath: string, field: string): Promise<string | undefined> {
  try {
    const content = await readFile(skillMdPath, 'utf-8')
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
    if (fm === null) return undefined
    const fmBody = fm[1] ?? ''
    const line = new RegExp(`^${field}:\\s*(.+)$`, 'm').exec(fmBody)
    return line === null ? undefined : sanitizeMetadata(line[1] ?? '')
  } catch {
    return undefined
  }
}

/** Inject a `source` field into the SKILL.md frontmatter, recording the origin repo. */
async function injectSourceField(skillMdPath: string, source: string): Promise<void> {
  let content: string
  try {
    content = await readFile(skillMdPath, 'utf-8')
  } catch {
    return
  }
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (fmMatch !== null) {
    let fm = fmMatch[1] ?? ''
    if (/^source:/m.test(fm)) {
      fm = fm.replace(/^source:.*$/m, `source: ${source}`)
    } else {
      fm = `${fm}\nsource: ${source}`
    }
    content = `---\n${fm}\n---\n${content.slice(fmMatch[0].length)}`
  } else {
    content = `---\nsource: ${source}\n---\n${content}`
  }
  await writeFile(skillMdPath, content, 'utf-8')
}

/**
 * Install skills from a GitHub repository: shallow clone into a temp dir,
 * discover SKILL.md bundles, copy matching ones into `skillsDir`, and record
 * the origin repo in each installed skill's frontmatter.
 */
export async function installGithubSkill(source: string, skillsDir: string): Promise<InstallResult> {
  const { url, skillFilter } = parseGithubSource(source)
  // Clean source for frontmatter: "owner/repo" (without @skill suffix)
  const cleanSource = url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '')

  const tmp = join(tmpdir(), `skills-clone-${randomBytes(6).toString('hex')}`)
  try {
    try {
      await execAsync(`git clone --depth 1 ${JSON.stringify(url)} ${JSON.stringify(tmp)}`, {
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch (error: unknown) {
      const err = error as { stderr?: { toString(): string }; message?: string }
      const message = err.stderr?.toString() ?? err.message ?? String(error)
      throw new Error(`git clone 失败: ${message}`)
    }

    const skillDirs = await findSkillDirs(tmp)
    if (skillDirs.length === 0) throw new Error('仓库中未发现技能（SKILL.md）')

    const installed: string[] = []
    const skipped: string[] = []
    await mkdir(skillsDir, { recursive: true })
    for (const dir of skillDirs) {
      const name = await frontmatterField(join(dir, 'SKILL.md'), 'name')
        .then(value => value ?? '')
      if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        skipped.push(name || dir)
        continue
      }
      if (skillFilter !== undefined && skillFilter !== name) {
        skipped.push(name)
        continue
      }
      const dest = join(skillsDir, name)
      await rm(dest, { recursive: true, force: true })
      await cp(dir, dest, { recursive: true })
      await injectSourceField(join(dest, 'SKILL.md'), cleanSource).catch(() => {})
      installed.push(name)
    }
    if (installed.length === 0 && skillFilter !== undefined) {
      throw new Error(`仓库中未找到指定技能: ${skillFilter}`)
    }
    return { installed, skipped }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}
