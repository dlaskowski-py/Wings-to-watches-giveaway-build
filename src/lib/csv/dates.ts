/**
 * Date parsing for bank and payment-app exports.
 *
 * The hard problem here is not format variety, it is AMBIGUITY. "03/04/2026" is
 * March 4th in a US export and April 3rd in a European one, and nothing in the
 * cell tells you which. Guessing wrong silently moves a payment across the
 * drawing window boundary, which changes who is eligible.
 *
 * So: default to US month-first (these are US bank and Venmo exports), detect
 * the cases where that reading is impossible, and FLAG anything that could
 * legitimately be read either way. The operator can force an interpretation per
 * import via the column mapping.
 *
 * Second trap: timezones. A payment made at 8pm Eastern on the 5th is
 * 00:00 UTC on the 6th. Converting a naive date through a Date object and back
 * shifts it by a day, which is exactly the kind of silent error that lands a
 * payment outside the window. `paidOn` is therefore carried as a plain
 * YYYY-MM-DD string built from the digits actually present in the cell — never
 * round-tripped through UTC.
 */

export type DateOrder = 'auto' | 'mdy' | 'dmy' | 'ymd'

export type DateFlag = 'ambiguous_date_order' | 'assumed_century' | 'no_time_component'

export interface ParsedDate {
  /** Calendar date exactly as written in the source. Never timezone-shifted. */
  paidOn: string
  /** Full instant, only when the cell actually carried a time. */
  paidAt: string | null
  flags: DateFlag[]
}

export type DateResult = { ok: true; value: ParsedDate } | { ok: false; reason: string }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2200) return false
  const daysInMonth = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28,
                       31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return d <= daysInMonth[m - 1]!
}

function ymd(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Two-digit years: 70-99 -> 19xx, 00-69 -> 20xx. Matches the POSIX convention. */
function expandYear(raw: string): { year: number; assumed: boolean } {
  if (raw.length === 4) return { year: Number(raw), assumed: false }
  const n = Number(raw)
  return { year: n >= 70 ? 1900 + n : 2000 + n, assumed: true }
}

export function parseDate(raw: string | null | undefined, order: DateOrder = 'auto'): DateResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' }
  const s = String(raw).replace(/[\u00a0\u2000-\u200a\u202f\u205f\ufeff]/g, ' ').trim()
  if (s === '') return { ok: false, reason: 'empty' }

  const flags: DateFlag[] = []

  // --- ISO 8601, with or without a time component -------------------------
  // Handled first and separately: it is the only format that can carry a real
  // timezone, and its date part is never ambiguous.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s)
  if (iso) {
    const [, yy, mm, dd, hh, mi, ss, tz] = iso
    const y = Number(yy), m = Number(mm), d = Number(dd)
    if (!isValidYmd(y, m, d)) return { ok: false, reason: `impossible date "${raw}"` }

    if (hh === undefined) {
      flags.push('no_time_component')
      return { ok: true, value: { paidOn: ymd(y, m, d), paidAt: null, flags } }
    }
    // With an explicit offset we have a real instant. Without one, the local
    // wall-clock reading is what the export meant, so keep the calendar date
    // from the digits and do not invent a timezone for it.
    const time = `${hh}:${mi}:${ss ?? '00'}`
    if (tz) {
      const normalisedTz = tz === 'Z' ? 'Z' : tz.includes(':') ? tz : `${tz.slice(0, 3)}:${tz.slice(3)}`
      return { ok: true, value: { paidOn: ymd(y, m, d), paidAt: `${ymd(y, m, d)}T${time}${normalisedTz}`, flags } }
    }
    return { ok: true, value: { paidOn: ymd(y, m, d), paidAt: `${ymd(y, m, d)}T${time}Z`, flags } }
  }

  // --- Month-name formats: "Sep 5, 2026", "5 September 2026" ---------------
  const named = /^(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})|(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4}))$/.exec(s)
  if (named) {
    const monthWord = (named[1] ?? named[5])!.toLowerCase()
    const dayStr = (named[2] ?? named[4])!
    const yearStr = (named[3] ?? named[6])!
    const m = MONTHS[monthWord]
    if (m === undefined) return { ok: false, reason: `unrecognised month "${monthWord}"` }
    const { year, assumed } = expandYear(yearStr)
    if (assumed) flags.push('assumed_century')
    const d = Number(dayStr)
    if (!isValidYmd(year, m, d)) return { ok: false, reason: `impossible date "${raw}"` }
    flags.push('no_time_component')
    return { ok: true, value: { paidOn: ymd(year, m, d), paidAt: null, flags } }
  }

  // --- Numeric slash/dash/dot formats, optionally with a time -------------
  const numeric = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[T ,]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/.exec(s)
  if (!numeric) return { ok: false, reason: `unrecognised date format "${raw}"` }

  const [, aStr, bStr, cStr, hhStr, miStr, ssStr, ampm] = numeric
  const a = Number(aStr), b = Number(bStr), c = Number(cStr)

  let year: number, month: number, day: number

  if (order === 'ymd' || aStr!.length === 4) {
    year = a; month = b; day = c
    if (aStr!.length === 4 && order !== 'ymd' && order !== 'auto') {
      // An explicit non-ymd order contradicts a 4-digit leading year; trust the digits.
      flags.push('ambiguous_date_order')
    }
  } else {
    const { year: y, assumed } = expandYear(cStr!)
    year = y
    if (assumed) flags.push('assumed_century')

    if (order === 'mdy') {
      month = a; day = b
    } else if (order === 'dmy') {
      day = a; month = b
    } else {
      // auto: US month-first by default, since these are US exports.
      if (a > 12 && b <= 12) {
        // Only one reading is possible.
        day = a; month = b
      } else if (b > 12 && a <= 12) {
        month = a; day = b
      } else {
        month = a; day = b
        // Both readings are valid calendar dates, e.g. 03/04. Flag unless the
        // two components are equal, where the reading does not matter.
        if (a !== b) flags.push('ambiguous_date_order')
      }
    }
  }

  if (!isValidYmd(year, month, day)) return { ok: false, reason: `impossible date "${raw}"` }

  const paidOn = ymd(year, month, day)
  if (hhStr === undefined) {
    flags.push('no_time_component')
    return { ok: true, value: { paidOn, paidAt: null, flags } }
  }

  let hour = Number(hhStr)
  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm'
    if (hour === 12) hour = isPm ? 12 : 0
    else if (isPm) hour += 12
  }
  if (hour > 23) return { ok: false, reason: `impossible time in "${raw}"` }

  const time = `${String(hour).padStart(2, '0')}:${miStr}:${ssStr ?? '00'}`
  return { ok: true, value: { paidOn, paidAt: `${paidOn}T${time}Z`, flags } }
}

/** True when `paidOn` (YYYY-MM-DD) sits inside an inclusive window. Pure string compare — no timezone involved. */
export function isWithinWindow(paidOn: string, start: string | null, end: string | null): boolean {
  if (start && paidOn < start) return false
  if (end && paidOn > end) return false
  return true
}

/** How confidently a column of sample values reads as dates. Used by column auto-detection. */
export function dateParseRate(values: readonly string[]): number {
  const candidates = values.filter((v) => v != null && String(v).trim() !== '')
  if (candidates.length === 0) return 0
  const parsed = candidates.filter((v) => parseDate(v).ok).length
  return parsed / candidates.length
}
