/**
 * Money parsing.
 *
 * Every dollar figure in this system passes through here on its way to integer
 * cents. Two rules govern the whole file:
 *
 *   1. NEVER use floating point. `parseFloat("0.29") * 100` is 28.999999999999996,
 *      and `Math.round` papering over that is how ledgers end up a cent short.
 *      Integer and fraction digits are parsed as separate strings and combined
 *      arithmetically.
 *
 *   2. NEVER guess silently. When a value is genuinely ambiguous — "1,50" could
 *      be $1.50 or a mangled $150 — parsing succeeds but raises a flag so the
 *      operator sees it in the review queue. A wrong number that looks confident
 *      is far more damaging than one that asks for a second look.
 */

export type AmountFlag =
  | 'ambiguous_separator'
  | 'non_usd_currency'
  | 'excess_precision'
  | 'negative_amount'

export interface ParsedAmount {
  /** Absolute value in integer cents. Always >= 0; check `negative` for direction. */
  cents: number
  /** True when the source rendered this as money leaving the account. */
  negative: boolean
  /** Currency code if the cell named one, uppercased. */
  currency: string | null
  flags: AmountFlag[]
}

export type AmountResult =
  | { ok: true; value: ParsedAmount }
  | { ok: false; reason: string }

/** Unicode spaces that CSV exports love and `String.trim()` sometimes misses. */
const UNICODE_SPACES = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/g
/** Minus sign, en dash and em dash all get used as a leading minus in the wild. */
const UNICODE_MINUS = /[\u2212\u2013\u2014]/g

const CURRENCY_SYMBOLS = /[$£€¥₹]/g
const CURRENCY_CODE = /\b([A-Z]{3})\b/

/**
 * Parse a raw cell into integer cents.
 *
 * Handles: "$25.00", "25", "+ $25.00", "-$25.00", "(25.00)", "1,250.00",
 * "25.00 USD", non-breaking spaces, unicode minus, and European "1.234,56".
 */
export function parseAmountToCents(raw: string | number | null | undefined): AmountResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'empty' }

  // A number straight from the CSV parser is already unambiguous. Round at the
  // cent to absorb the float error the parser itself may have introduced.
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, reason: 'not a finite number' }
    const cents = Math.round(Math.abs(raw) * 100)
    return {
      ok: true,
      value: { cents, negative: raw < 0, currency: null, flags: raw < 0 ? ['negative_amount'] : [] },
    }
  }

  const flags: AmountFlag[] = []

  let s = raw.replace(UNICODE_SPACES, ' ').replace(UNICODE_MINUS, '-').trim()
  if (s === '') return { ok: false, reason: 'empty' }
  // Placeholders banks use for "nothing here".
  if (/^(-|--|n\/?a|none|null)$/i.test(s)) return { ok: false, reason: 'placeholder value' }

  // Accounting notation: (25.00) means negative.
  let negative = false
  const parenthesised = /^\((.*)\)$/.exec(s)
  if (parenthesised) {
    negative = true
    s = parenthesised[1]!.trim()
  }

  // Currency code, e.g. "25.00 USD". Anything other than USD is worth a look.
  const upper = s.toUpperCase()
  let currency: string | null = null
  const codeMatch = CURRENCY_CODE.exec(upper)
  if (codeMatch) {
    currency = codeMatch[1]!
    s = s.replace(new RegExp(`\\b${currency}\\b`, 'i'), '').trim()
    if (currency !== 'USD') flags.push('non_usd_currency')
  }

  if (CURRENCY_SYMBOLS.test(s)) {
    CURRENCY_SYMBOLS.lastIndex = 0
    // A non-dollar symbol means the amount is not USD even without a code.
    if (/[£€¥₹]/.test(s) && currency === null) flags.push('non_usd_currency')
    s = s.replace(CURRENCY_SYMBOLS, '')
  }
  s = s.replace(/\s+/g, '').trim()

  // Leading/trailing sign. Venmo writes "+ $25.00" and "- $25.00".
  if (s.startsWith('-')) {
    negative = true
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  }
  if (s.endsWith('-')) {
    negative = true
    s = s.slice(0, -1)
  }
  s = s.trim()
  if (s === '') return { ok: false, reason: 'no digits' }

  if (!/^[0-9.,]+$/.test(s)) return { ok: false, reason: `unrecognized characters in "${raw}"` }

  const { intPart, fracPart, error, ambiguous } = splitDecimal(s)
  if (error) return { ok: false, reason: error }
  if (ambiguous) flags.push('ambiguous_separator')

  if (fracPart.length > 2) flags.push('excess_precision')

  // Integer arithmetic only.
  const intDigits = intPart === '' ? '0' : intPart
  if (!/^\d+$/.test(intDigits)) return { ok: false, reason: `unrecognized number "${raw}"` }
  const centsFromInt = Number(intDigits) * 100
  const centsFromFrac = Number((fracPart + '00').slice(0, 2))
  const cents = centsFromInt + centsFromFrac

  if (!Number.isSafeInteger(cents)) return { ok: false, reason: `amount out of range: "${raw}"` }
  if (negative) flags.push('negative_amount')

  return { ok: true, value: { cents, negative, currency, flags } }
}

interface DecimalSplit {
  intPart: string
  fracPart: string
  error?: string
  ambiguous?: boolean
}

/**
 * Work out which of `.` and `,` is the decimal point.
 *
 * US bank exports use "1,250.00"; some European exports use "1.250,00". When
 * both separators appear the last one is the decimal point, which is
 * unambiguous. When only one appears we look at the digit grouping: exactly
 * three trailing digits means a thousands separator, otherwise it is a decimal
 * point — and "1,50" (one comma, two trailing digits) genuinely could be either,
 * so it is parsed as a decimal AND flagged rather than quietly picked.
 */
function splitDecimal(s: string): DecimalSplit {
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')

  if (lastDot === -1 && lastComma === -1) return { intPart: s, fracPart: '' }

  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the rightmost is the decimal separator.
    const decimalAt = Math.max(lastDot, lastComma)
    const groupSep = decimalAt === lastDot ? ',' : '.'
    const intPart = s.slice(0, decimalAt).split(groupSep).join('')
    const fracPart = s.slice(decimalAt + 1)
    if (fracPart.includes('.') || fracPart.includes(',')) {
      return { intPart: '', fracPart: '', error: `cannot interpret separators in "${s}"` }
    }
    return { intPart, fracPart }
  }

  const sep = lastDot !== -1 ? '.' : ','
  const at = lastDot !== -1 ? lastDot : lastComma
  const before = s.slice(0, at)
  const after = s.slice(at + 1)

  if (after.includes(sep)) return { intPart: '', fracPart: '', error: `cannot interpret "${s}"` }

  const occurrences = s.split(sep).length - 1
  if (occurrences > 1) {
    // "1.234.567" — repeated separator can only be grouping.
    if (after.length !== 3) return { intPart: '', fracPart: '', error: `cannot interpret "${s}"` }
    return { intPart: s.split(sep).join(''), fracPart: '' }
  }

  if (after.length === 3) {
    // Exactly one separator with three trailing digits.
    //   "1,250"  -> comma is a thousands separator (US convention): $1,250.00
    //   "25.005" -> dot is the decimal point with excess precision: $25.00
    // Reading a dot as a thousands separator would turn $25.005 into $25,005,
    // and these are US exports where "." is essentially always the decimal
    // point. The excess_precision flag (raised by the caller when fracPart is
    // longer than two digits) is what surfaces the oddity to the operator.
    if (sep === ',') return { intPart: before + after, fracPart: '' }
    return { intPart: before, fracPart: after }
  }

  if (sep === ',' && after.length === 2 && before.length <= 3) {
    // "1,50" — European decimal or a US thousands separator typo. Read it as a
    // decimal (the commoner case) but flag it for a human.
    return { intPart: before, fracPart: after, ambiguous: true }
  }

  return { intPart: before, fracPart: after }
}

/** Integer cents -> "$1,234.56". Used for display and for Excel/CSV export. */
export function formatCents(cents: number, withSymbol = true): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const remainder = abs % 100
  const grouped = dollars.toLocaleString('en-US')
  const body = `${grouped}.${String(remainder).padStart(2, '0')}`
  return `${negative ? '-' : ''}${withSymbol ? '$' : ''}${body}`
}

/**
 * Entry arithmetic, mirroring the `compute_payment_entries` trigger exactly.
 *
 * The database is the source of truth; this exists so the import wizard can
 * show the operator what they are about to commit BEFORE anything is written.
 * If the two ever disagree, the trigger wins — and that is a bug worth fixing
 * immediately, so `entryMathMatches` in the test suite pins them together.
 */
export function computeEntries(amountCents: number, ticketPriceCents: number, incoming: boolean) {
  if (ticketPriceCents <= 0) throw new Error('Ticket price must be positive')
  if (!incoming || amountCents <= 0) return { entries: 0, remainderCents: 0 }
  return {
    entries: Math.floor(amountCents / ticketPriceCents),
    remainderCents: amountCents % ticketPriceCents,
  }
}
