export const DICEBEAR_BASE = 'https://api.dicebear.com/10.x'

export type DicebearStyle = 'bottts' | 'bottts-neutral' | 'adventurer-neutral' | 'open-peeps'

export const DICEBEAR_STYLES: { key: DicebearStyle; label: string }[] = [
  { key: 'bottts-neutral', label: 'Bottts Neutral' },
  { key: 'bottts', label: 'Bottts' },
  { key: 'adventurer-neutral', label: 'Adventurer Neutral' },
  { key: 'open-peeps', label: 'Open Peeps' },
]

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

export function dicebearUrl(style: DicebearStyle, seed: string): string {
  return `${DICEBEAR_BASE}/${style}/svg?seed=${encodeURIComponent(seed)}`
}
