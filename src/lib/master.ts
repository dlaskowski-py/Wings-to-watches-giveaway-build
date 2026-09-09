/**
 * Master roll-up: one row per person, combining every source.
 *
 * The ledger export lists payments; this answers the question the ledger cannot,
 * which is "what did this person actually do across Venmo AND Zelle". That
 * matters because the same human routinely pays through both, and until those
 * rows are collapsed onto one entrant nobody can eyeball whether their ticket
 * count is right.
 *
 * Deliberately includes the money that did NOT earn tickets — excluded rows,
 * duplicates, unallocated remainder — because a summary that shows only the
 * tidy total is exactly the summary you cannot reconcile against a bank
 * statement.
 */
import type { Entrant, Payment, PaymentSourceDb } from './types'

export interface MasterRow {
  entrantId: string | null
  displayName: string
  displayLabel: string
  email: string | null
  phone: string | null

  /** Counted payments and money, split by where they came from. */
  bySource: Record<PaymentSourceDb, { payments: number; cents: number }>

  approvedPayments: number
  approvedCents: number
  tickets: number
  unallocatedCents: number

  excludedPayments: number
  excludedCents: number
  duplicatePayments: number
  pendingPayments: number
  outgoingPayments: number

  firstPaidOn: string | null
  lastPaidOn: string | null
  flags: string[]
  /** True when this row's payments were never matched to an entrant. */
  unassigned: boolean
}

export interface MasterSummary {
  entrantCount: number
  totalTickets: number
  approvedCents: number
  excludedCents: number
  excludedPayments: number
  unallocatedCents: number
  pendingPayments: number
  duplicatePayments: number
  unassignedRows: number
  bySource: Record<PaymentSourceDb, { payments: number; cents: number }>
}

const SOURCES: PaymentSourceDb[] = ['venmo', 'zelle', 'other', 'manual']

function emptyBySource(): Record<PaymentSourceDb, { payments: number; cents: number }> {
  return {
    venmo: { payments: 0, cents: 0 },
    zelle: { payments: 0, cents: 0 },
    other: { payments: 0, cents: 0 },
    manual: { payments: 0, cents: 0 },
  }
}

/**
 * Build the roll-up.
 *
 * Payments never matched to an entrant are NOT dropped — they are grouped by
 * the name on the payment and marked `unassigned`, because money that arrived
 * from somebody the system could not identify is the single most important
 * thing for the operator to see, not the easiest thing to hide.
 */
export function buildMasterRows(payments: readonly Payment[], entrants: readonly Entrant[]): MasterRow[] {
  const byId = new Map(entrants.map((e) => [e.id, e]))
  const rows = new Map<string, MasterRow>()

  const keyFor = (p: Payment) =>
    p.entrant_id ?? `unassigned:${(p.raw_payer_name ?? p.payer_email ?? p.payer_handle ?? 'unknown').toLowerCase()}`

  for (const p of payments) {
    const key = keyFor(p)
    let row = rows.get(key)

    if (!row) {
      const entrant = p.entrant_id ? byId.get(p.entrant_id) : undefined
      const fallbackName = p.raw_payer_name ?? p.payer_email ?? p.payer_handle ?? 'Unidentified payer'
      row = {
        entrantId: p.entrant_id,
        displayName: entrant?.display_name ?? fallbackName,
        displayLabel: entrant?.display_label ?? '—',
        email: entrant?.primary_email ?? p.payer_email,
        phone: entrant?.primary_phone ?? p.payer_phone,
        bySource: emptyBySource(),
        approvedPayments: 0, approvedCents: 0, tickets: 0, unallocatedCents: 0,
        excludedPayments: 0, excludedCents: 0, duplicatePayments: 0,
        pendingPayments: 0, outgoingPayments: 0,
        firstPaidOn: null, lastPaidOn: null, flags: [],
        unassigned: !p.entrant_id,
      }
      rows.set(key, row)
    }

    if (p.direction === 'out') {
      row.outgoingPayments += 1
    } else if (p.status === 'approved') {
      row.approvedPayments += 1
      row.approvedCents += p.amount_cents
      row.tickets += p.entries
      row.unallocatedCents += p.remainder_cents
      const bucket = row.bySource[p.source] ?? row.bySource.other
      bucket.payments += 1
      bucket.cents += p.amount_cents
    } else if (p.status === 'excluded') {
      row.excludedPayments += 1
      row.excludedCents += p.amount_cents
    } else if (p.status === 'duplicate') {
      row.duplicatePayments += 1
    } else {
      row.pendingPayments += 1
    }

    if (p.paid_on) {
      if (!row.firstPaidOn || p.paid_on < row.firstPaidOn) row.firstPaidOn = p.paid_on
      if (!row.lastPaidOn || p.paid_on > row.lastPaidOn) row.lastPaidOn = p.paid_on
    }
    for (const f of p.flags) if (!row.flags.includes(f)) row.flags.push(f)
  }

  // Entrants with no payments at all still belong in a master record — an empty
  // row is a fact worth seeing, not a row worth omitting.
  for (const e of entrants) {
    if (rows.has(e.id)) continue
    rows.set(e.id, {
      entrantId: e.id,
      displayName: e.display_name,
      displayLabel: e.display_label,
      email: e.primary_email,
      phone: e.primary_phone,
      bySource: emptyBySource(),
      approvedPayments: 0, approvedCents: 0, tickets: 0, unallocatedCents: 0,
      excludedPayments: 0, excludedCents: 0, duplicatePayments: 0,
      pendingPayments: 0, outgoingPayments: 0,
      firstPaidOn: null, lastPaidOn: null, flags: [], unassigned: false,
    })
  }

  // Most tickets first — the people with the most at stake read first. Ties
  // break by name so the ordering is stable between exports.
  return [...rows.values()].sort(
    (a, b) => b.tickets - a.tickets || a.displayName.localeCompare(b.displayName),
  )
}

export function summariseMaster(rows: readonly MasterRow[]): MasterSummary {
  const bySource = emptyBySource()
  for (const r of rows) {
    for (const s of SOURCES) {
      bySource[s].payments += r.bySource[s].payments
      bySource[s].cents += r.bySource[s].cents
    }
  }
  return {
    entrantCount: rows.filter((r) => r.tickets > 0).length,
    totalTickets: rows.reduce((n, r) => n + r.tickets, 0),
    approvedCents: rows.reduce((n, r) => n + r.approvedCents, 0),
    excludedCents: rows.reduce((n, r) => n + r.excludedCents, 0),
    excludedPayments: rows.reduce((n, r) => n + r.excludedPayments, 0),
    unallocatedCents: rows.reduce((n, r) => n + r.unallocatedCents, 0),
    pendingPayments: rows.reduce((n, r) => n + r.pendingPayments, 0),
    duplicatePayments: rows.reduce((n, r) => n + r.duplicatePayments, 0),
    unassignedRows: rows.filter((r) => r.unassigned).length,
    bySource,
  }
}

/** Odds as a "1 in N" figure, or null when the person holds no tickets. */
/**
 * Odds expressed as "1 in N". Rounding to a whole number is fine once the pool
 * is large, but in a small pool it collapses distinct ticket counts onto the
 * same figure (4 of 10 tickets and 3 of 10 both round to "1 in 3"), which reads
 * as an error on a sheet whose whole job is showing that the numbers add up.
 * Keep a decimal below 10 so every different ticket count prints differently.
 */
export function oddsOneIn(tickets: number, totalTickets: number): number | null {
  if (tickets <= 0 || totalTickets <= 0) return null
  const ratio = totalTickets / tickets
  return ratio < 10 ? Math.round(ratio * 10) / 10 : Math.round(ratio)
}
