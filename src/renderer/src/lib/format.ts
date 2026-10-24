export function money(v: number | null | undefined, digits?: number) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  const d = digits ?? (Math.abs(v) < 1 && v !== 0 ? 4 : 2)
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: Math.min(2, d), maximumFractionDigits: d })}`
}

export function when(iso: string | null | undefined) {
  if (!iso) return '—'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60_000) return diff >= 0 ? 'just now' : 'in a moment'
  if (abs < 3600_000) return rtf.format(-Math.round(diff / 60_000), 'minute')
  if (abs < 86400_000) return rtf.format(-Math.round(diff / 3600_000), 'hour')
  if (abs < 7 * 86400_000) return rtf.format(-Math.round(diff / 86400_000), 'day')
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function dateTime(iso: string | null | undefined) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export function duration(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`
}

export function pct(v: number | null | undefined, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—'
  return `${(v * 100).toFixed(digits)}%`
}

export function plural(n: number, word: string, pluralWord?: string) {
  return `${n} ${n === 1 ? word : (pluralWord ?? `${word}s`)}`
}

export function short(v: unknown, max = 120): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s === undefined) return ''
  return s.length > max ? `${s.slice(0, max)}…` : s
}
