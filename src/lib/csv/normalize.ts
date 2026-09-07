/**
 * Row normalisation: a raw CSV grid plus a column mapping becomes a list of
 * payment records ready for the review queue.
 *
 * The guiding rule is that this stage NEVER silently discards money. A row it
 * cannot fully understand still comes through, carrying flags that say what is
 * wrong, so it lands in front of the operator instead of vanishing. The only
 * rows that get rejected outright are ones with no readable amount at all —
 * blank lines, running-balance footers, section separators.
 */

import { computeEntries, parseAmountToCents } from './amount'
import { parseDate } from './dates'
import { sha256Hex } from '../draw/core'
import {
  buildAliases,
  emailMatchKey,
  extractPayerFromDescription,
  normalizeEmail,
  normalizeHandle,
  normalizeName,
  normalizePhone,
} from './identity'
import type { Grid } from './detect'
import type {
  ColumnMapping,
  ImportPreview,
  NormalizedPayment,
  PaymentFlag,
} from './types'

const DEDUPE_TAG = 'wtw-dedupe/v1'

/** Amounts above this many tickets get a second look. 40 x $25 = $1,000. */
const LARGE_AMOUNT_TICKETS = 40

export interface NormalizeOptions {
  mapping: ColumnMapping
  ticketPriceCents: number
  windowStart?: string | null
  windowEnd?: string | null
}

function cell(row: readonly string[], index: number | undefined): string {
  if (index === undefined) return ''
  return (row[index] ?? '').trim()
}

/**
 * Neutralise spreadsheet formula injection.
 *
 * A payer can type anything into a Venmo note, including
 * `=HYPERLINK("http://evil","click")` or `=cmd|'/c calc'!A1`. That text is
 * inert in our UI, but the operator exports "the excel" and opens it — at which
 * point Excel would happily evaluate it. Prefixing with an apostrophe forces
 * Excel to treat the cell as literal text.
 *
 * Applied at EXPORT time rather than on import, so the database keeps exactly
 * what the payer actually wrote.
 */
export function sanitizeForSpreadsheet(value: string | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (s === '') return ''
  // Leading whitespace does not protect the cell; Excel trims it first.
  const firstMeaningful = s.replace(/^[\s ]+/, '')
  if (/^[=+\-@\t\r]/.test(firstMeaningful)) return `'${s}`
  return s
}

/** True when a note or description contains something Excel would evaluate. */
export function looksLikeFormula(value: string | null | undefined): boolean {
  if (!value) return false
  return /^[\s ]*[=+\-@]/.test(String(value)) && /[=|!(]/.test(String(value))
}

/**
 * Dedupe key for a payment.
 *
 * A stable transaction id from the export is by far the best signal, so it wins
 * when present. Otherwise we hash the content that identifies the payment:
 * source, date, amount, direction, payer, and note.
 *
 * Two genuinely distinct payments CAN collide here — the same person really can
 * send $25 twice on the same day with the same note. That is why a collision
 * marks the second row `duplicate` for review rather than dropping it: the
 * operator confirms whether it is a real second payment, and if so it is stored
 * with occurrence = 1 alongside the first.
 */
export async function computeDedupeHash(payment: {
  source: string
  externalRef: string | null
  paidOn: string | null
  amountCents: number
  direction: string
  payerKey: string
  note: string | null
}): Promise<string> {
  if (payment.externalRef && payment.externalRef.trim() !== '') {
    return sha256Hex(`${DEDUPE_TAG}|ref|${payment.source}|${payment.externalRef.trim().toLowerCase()}`)
  }
  const note = (payment.note ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  return sha256Hex(
    [
      DEDUPE_TAG,
      'content',
      payment.source,
      payment.paidOn ?? 'nodate',
      String(payment.amountCents),
      payment.direction,
      payment.payerKey,
      note,
    ].join('|'),
  )
}

/** Stable identity key for a payer, preferring the least ambiguous signal available. */
export function payerKeyFor(input: {
  email?: string | null
  phone?: string | null
  handle?: string | null
  name?: string | null
}): string {
  const email = emailMatchKey(input.email)
  if (email) return `email:${email}`
  const phone = normalizePhone(input.phone)
  if (phone) return `phone:${phone}`
  const handle = normalizeHandle(input.handle)
  if (handle) return `handle:${handle}`
  const name = normalizeName(input.name)
  if (name) return `name:${name}`
  return 'unknown'
}

interface AmountReading {
  cents: number
  direction: 'in' | 'out'
  flags: PaymentFlag[]
  error?: string
}

function readAmount(row: readonly string[], mapping: ColumnMapping): AmountReading {
  const flags: PaymentFlag[] = []

  if (mapping.directionMode === 'credit_debit') {
    const creditRaw = cell(row, mapping.roles.credit)
    const debitRaw = cell(row, mapping.roles.debit)
    const credit = creditRaw ? parseAmountToCents(creditRaw) : null
    const debit = debitRaw ? parseAmountToCents(debitRaw) : null

    if (credit?.ok && credit.value.cents > 0) {
      flags.push(...(credit.value.flags.filter((f) => f !== 'negative_amount') as PaymentFlag[]))
      return { cents: credit.value.cents, direction: 'in', flags }
    }
    if (debit?.ok && debit.value.cents > 0) {
      flags.push(...(debit.value.flags.filter((f) => f !== 'negative_amount') as PaymentFlag[]))
      return { cents: debit.value.cents, direction: 'out', flags }
    }
    return { cents: 0, direction: 'in', flags, error: 'no credit or debit amount in this row' }
  }

  const raw = cell(row, mapping.roles.amount)
  if (raw === '') return { cents: 0, direction: 'in', flags, error: 'amount column is empty' }

  const parsed = parseAmountToCents(raw)
  if (!parsed.ok) {
    flags.push('unparseable_amount')
    return { cents: 0, direction: 'in', flags, error: parsed.reason }
  }

  for (const f of parsed.value.flags) {
    if (f === 'negative_amount') continue
    flags.push(f as PaymentFlag)
  }

  let direction: 'in' | 'out' = 'in'
  if (mapping.directionMode === 'sign') {
    direction = parsed.value.negative ? 'out' : 'in'
  } else if (mapping.directionMode === 'type_column') {
    const type = `${cell(row, mapping.roles.type)} ${cell(row, mapping.roles.status)}`.toLowerCase()
    if (/\b(charge|debit|withdraw|sent|payment to|purchase|transfer out)\b/.test(type)) direction = 'out'
    else if (parsed.value.negative) direction = 'out'
  } else if (parsed.value.negative) {
    // 'all_incoming' still respects an explicit minus sign — a refund is a
    // refund even in a file we were told is all deposits.
    direction = 'out'
  }

  return { cents: parsed.value.cents, direction, flags }
}

/** Statuses that mean the money did not actually move. */
const FAILED_STATUS = /^(fail(ed)?|cancell?ed|declin(ed)?|return(ed)?|reversed|expired|pending|incomplete)$/i

/**
 * Turn a raw grid into normalised payments.
 *
 * Returns a full preview object — including the totals that drive the wizard's
 * dry-run summary — so the operator sees exactly what will be written before
 * anything is written.
 */
export async function normalizeRows(
  headers: readonly string[],
  dataRows: Grid,
  options: NormalizeOptions,
): Promise<ImportPreview> {
  const { mapping, ticketPriceCents, windowStart = null, windowEnd = null } = options

  const rows: NormalizedPayment[] = []
  const rejected: ImportPreview['rejected'] = []

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i]!
    // 1-based, as a spreadsheet shows it. `dataRows` mirrors the file below the
    // header, blank lines included, so the index alone is the true line number.
    // (Counting non-blank rows instead pointed the operator at the wrong line
    // for everything below the first gap.)
    const sourceRowNumber = mapping.headerRowIndex + 2 + i

    const rawRow: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]?.trim() || `column_${c + 1}`
      rawRow[key] = (row[c] ?? '').trim()
    }

    if (row.every((c) => (c ?? '').trim() === '')) continue // blank line

    const flags: PaymentFlag[] = []
    const amount = readAmount(row, mapping)

    if (amount.error && amount.cents === 0) {
      rejected.push({ sourceRowNumber, reason: amount.error, rawRow })
      continue
    }
    flags.push(...amount.flags)

    // --- date ------------------------------------------------------------
    const dateRaw = cell(row, mapping.roles.date)
    let paidOn: string | null = null
    let paidAt: string | null = null
    if (dateRaw === '') {
      flags.push('missing_date')
    } else {
      const parsed = parseDate(dateRaw, mapping.dateOrder)
      if (parsed.ok) {
        paidOn = parsed.value.paidOn
        paidAt = parsed.value.paidAt
        for (const f of parsed.value.flags) {
          if (f === 'no_time_component') continue // not interesting to the operator
          flags.push(f as PaymentFlag)
        }
      } else {
        flags.push('unparseable_date')
      }
    }

    if (paidOn && (windowStart || windowEnd)) {
      if ((windowStart && paidOn < windowStart) || (windowEnd && paidOn > windowEnd)) {
        flags.push('outside_window')
      }
    }

    // --- payer identity ---------------------------------------------------
    let rawPayerName = cell(row, mapping.roles.payer_name) || null
    const description = cell(row, mapping.roles.description) || null
    const email = normalizeEmail(cell(row, mapping.roles.payer_email)) || null
    const phone = normalizePhone(cell(row, mapping.roles.payer_phone)) || null
    const handle = normalizeHandle(cell(row, mapping.roles.payer_handle)) || null

    let direction = amount.direction
    if (!rawPayerName && description) {
      // Bank-style Zelle rows keep the counterparty inside the description.
      const extracted = extractPayerFromDescription(description)
      if (extracted) {
        rawPayerName = extracted.name
        flags.push('name_from_description')
        // The description often states the direction more reliably than the sign.
        if (extracted.direction === 'to' && mapping.directionMode !== 'credit_debit') direction = 'out'
      }
    }

    const payerName = rawPayerName ? normalizeName(rawPayerName) : ''
    if (!payerName && !email && !phone && !handle) flags.push('missing_payer')

    // --- status -----------------------------------------------------------
    const status = cell(row, mapping.roles.status)
    if (status && FAILED_STATUS.test(status)) flags.push('failed_status')

    // --- note -------------------------------------------------------------
    const note = cell(row, mapping.roles.note) || null
    if (looksLikeFormula(note) || looksLikeFormula(description)) flags.push('formula_sanitized')

    // --- entries ----------------------------------------------------------
    const { entries, remainderCents } = computeEntries(amount.cents, ticketPriceCents, direction === 'in')
    if (direction === 'out') flags.push('outgoing')
    if (remainderCents > 0) flags.push('partial_amount')
    if (direction === 'in' && entries === 0 && amount.cents > 0) flags.push('zero_entries')
    if (entries >= LARGE_AMOUNT_TICKETS) flags.push('large_amount')

    const externalRef = cell(row, mapping.roles.external_ref) || null
    const payerKey = payerKeyFor({ email, phone, handle, name: rawPayerName })

    const dedupeHash = await computeDedupeHash({
      source: mapping.source,
      externalRef,
      paidOn,
      amountCents: amount.cents,
      direction,
      payerKey,
      note,
    })

    rows.push({
      sourceRowNumber,
      source: mapping.source,
      rawPayerName,
      payerName: rawPayerName,
      payerEmail: email,
      payerPhone: phone,
      payerHandle: handle,
      paidOn,
      paidAt,
      amountCents: amount.cents,
      direction,
      note,
      externalRef,
      entries,
      remainderCents,
      flags: dedupeFlags(flags),
      dedupeHash,
      rawRow,
    })
  }

  const incoming = rows.filter((r) => r.direction === 'in')
  const totals = {
    rowCount: dataRows.length,
    usableCount: rows.length,
    incomingCount: incoming.length,
    outgoingCount: rows.length - incoming.length,
    totalCents: incoming.reduce((sum, r) => sum + r.amountCents, 0),
    totalEntries: rows.reduce((sum, r) => sum + r.entries, 0),
    unallocatedCents: rows.reduce((sum, r) => sum + r.remainderCents, 0),
    flaggedCount: rows.filter((r) => r.flags.length > 0).length,
  }

  return { headerRowIndex: mapping.headerRowIndex, headers: [...headers], mapping, rows, rejected, totals }
}

function dedupeFlags(flags: readonly PaymentFlag[]): PaymentFlag[] {
  return [...new Set(flags)]
}

/**
 * Mark rows whose dedupe hash collides — within this file, or against hashes
 * already stored for this drawing.
 *
 * The FIRST occurrence stays reviewable; later ones are marked duplicates. The
 * operator can still promote a genuine second payment in the review queue.
 */
export function markDuplicates(
  rows: NormalizedPayment[],
  existingHashes: ReadonlySet<string>,
): { rows: NormalizedPayment[]; duplicateCount: number } {
  const seen = new Set(existingHashes)
  let duplicateCount = 0

  const out = rows.map((row) => {
    if (seen.has(row.dedupeHash)) {
      duplicateCount += 1
      return { ...row, flags: dedupeFlags([...row.flags, 'duplicate_suspected']) }
    }
    seen.add(row.dedupeHash)
    return row
  })

  return { rows: out, duplicateCount }
}

/** Re-export so callers building entrants have one import site. */
export { buildAliases }
