import { formatCents } from './csv/amount'

export { formatCents }

/** "2026-09-05" -> "Sep 5, 2026". Parsed as plain digits so no timezone shift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const [, y, mo, d] = m
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  return `${months[Number(mo) - 1]} ${Number(d)}, ${y}`
}

/** Full timestamp in the viewer's own timezone, for audit trails. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.round((then - Date.now()) / 1000)
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60], ['minute', 60], ['hour', 24], ['day', 7], ['week', 4.35], ['month', 12], ['year', Infinity],
  ]
  let value = seconds
  for (const [unit, size] of units) {
    if (Math.abs(value) < size) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(value), unit)
    }
    value /= size
  }
  return ''
}

/** Countdown like "4m 12s", for the wait between locking and the beacon landing. */
export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'now'
  const total = Math.ceil(msRemaining / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? singular : plural}`
}

/** Shorten a 64-char hash for display; full value stays available on hover/copy. */
export function shortHash(hash: string | null | undefined, chars = 8): string {
  if (!hash) return '—'
  if (hash.length <= chars * 2 + 1) return hash
  return `${hash.slice(0, chars)}…${hash.slice(-chars)}`
}
