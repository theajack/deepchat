import { t } from '../i18n'

const AVATAR_COLORS = ['#07C160', '#378ADD', '#7F77DD', '#D85A30', '#C24A6E', '#2D9D8F', '#B8860B', '#5B8C5A']

/** 按名称哈希取稳定头像色 */
export function avatarColor(seed: string): string {
  let hash = 0
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]
}

export function avatarChar(name: string): string {
  return name.trim().charAt(0) || '?'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 消息气泡旁时间 */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 会话列表时间：今天显示时分，昨天显示"昨天"，一周内显示周几，更早显示月-日 */
export function formatListTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const nowDate = new Date()
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime()
  if (ts >= startOfToday) return formatTime(ts)
  if (ts >= startOfToday - 86400000) return t('time.yesterday')
  const week = [
    t('time.sunday'),
    t('time.monday'),
    t('time.tuesday'),
    t('time.wednesday'),
    t('time.thursday'),
    t('time.friday'),
    t('time.saturday'),
  ]
  if (ts >= startOfToday - 6 * 86400000) return week[d.getDay()]
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 聊天区时间分隔条 */
export function formatSeparator(ts: number): string {
  const list = formatListTime(ts)
  return list.includes(':') ? t('time.today', { time: list }) : `${list} ${formatTime(ts)}`
}

/** 详情页创建时间：YYYY-MM-DD HH:mm */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
