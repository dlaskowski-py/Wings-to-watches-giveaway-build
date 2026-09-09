import { describe, expect, it } from 'vitest'
import { buildMasterRows, oddsOneIn, summariseMaster } from './master'
import type { Entrant, Payment } from './types'

function payment(over: Partial<Payment>): Payment {
  return {
    id: Math.random().toString(36).slice(2), drawing_id: 'd', batch_id: null, entrant_id: null,
    source: 'venmo', raw_payer_name: null, payer_name: null, payer_email: null, payer_phone: null,
    payer_handle: null, paid_at: null, paid_on: '2026-07-15', amount_cents: 2500, direction: 'in',
    note: null, external_ref: null, raw_row: {}, source_row_number: null, entries: 1,
    entries_override: null, override_reason: null, remainder_cents: 0, status: 'approved',
    exclude_reason: null, flags: [], dedupe_hash: 'h', occurrence: 0,
    created_at: '', updated_at: '', ...over,
  }
}

function entrant(id: string, name: string, over: Partial<Entrant> = {}): Entrant {
  return {
    id, drawing_id: 'd', public_id: `pub-${id}`, display_name: name,
    display_label: `${name.split(' ')[0]} ${name.split(' ')[1]?.[0] ?? ''}.`,
    primary_email: null, primary_phone: null, notes: null, created_at: '', updated_at: '', ...over,
  }
}

describe('buildMasterRows', () => {
  it('combines one person across Venmo and Zelle into a single row', () => {
    // This is the whole point of the master export: the same human paying
    // through both rails should read as one line with one ticket count.
    const rows = buildMasterRows(
      [
        payment({ entrant_id: 'e1', source: 'venmo', amount_cents: 5000, entries: 2, paid_on: '2026-07-02' }),
        payment({ entrant_id: 'e1', source: 'zelle', amount_cents: 2500, entries: 1, paid_on: '2026-08-20' }),
      ],
      [entrant('e1', 'Daniel Laskowski')],
    )

    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.displayName).toBe('Daniel Laskowski')
    expect(r.tickets).toBe(3)
    expect(r.approvedCents).toBe(7500)
    expect(r.bySource.venmo).toEqual({ payments: 1, cents: 5000 })
    expect(r.bySource.zelle).toEqual({ payments: 1, cents: 2500 })
    expect(r.firstPaidOn).toBe('2026-07-02')
    expect(r.lastPaidOn).toBe('2026-08-20')
  })

  it('keeps the money that did NOT earn tickets visible', () => {
    // A summary showing only the tidy total is the one you cannot reconcile
    // against a bank statement.
    const rows = buildMasterRows(
      [
        payment({ entrant_id: 'e1', amount_cents: 6000, entries: 2, remainder_cents: 1000, flags: ['partial_amount'] }),
        payment({ entrant_id: 'e1', amount_cents: 2500, status: 'excluded' }),
        payment({ entrant_id: 'e1', amount_cents: 2500, status: 'duplicate' }),
        payment({ entrant_id: 'e1', amount_cents: 2500, status: 'needs_review' }),
        payment({ entrant_id: 'e1', amount_cents: 2500, direction: 'out', entries: 0 }),
      ],
      [entrant('e1', 'Emily Nguyen')],
    )
    const r = rows[0]!
    expect(r.tickets).toBe(2)
    expect(r.unallocatedCents).toBe(1000)
    expect(r.excludedPayments).toBe(1)
    expect(r.excludedCents).toBe(2500)
    expect(r.duplicatePayments).toBe(1)
    expect(r.pendingPayments).toBe(1)
    expect(r.outgoingPayments).toBe(1)
    expect(r.flags).toContain('partial_amount')
    // Only approved incoming money counts toward the total.
    expect(r.approvedCents).toBe(6000)
  })

  it('surfaces unmatched payments instead of dropping them', () => {
    const rows = buildMasterRows(
      [payment({ entrant_id: null, raw_payer_name: 'Mystery Payer', amount_cents: 2500, entries: 1 })],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.unassigned).toBe(true)
    expect(rows[0]!.displayName).toBe('Mystery Payer')
  })

  it('groups several unmatched payments from the same name together', () => {
    const rows = buildMasterRows(
      [
        payment({ entrant_id: null, raw_payer_name: 'Mystery Payer', amount_cents: 2500, entries: 1 }),
        payment({ entrant_id: null, raw_payer_name: 'mystery payer', amount_cents: 2500, entries: 1 }),
      ],
      [],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tickets).toBe(2)
  })

  it('includes entrants who have no payments at all', () => {
    const rows = buildMasterRows([], [entrant('e1', 'Silent Member')])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tickets).toBe(0)
    expect(rows[0]!.approvedCents).toBe(0)
  })

  it('orders by tickets, then name, so exports are stable', () => {
    const rows = buildMasterRows(
      [
        payment({ entrant_id: 'e1', entries: 1 }),
        payment({ entrant_id: 'e2', entries: 5 }),
        payment({ entrant_id: 'e3', entries: 1 }),
      ],
      [entrant('e1', 'Zoe Adams'), entrant('e2', 'Aisha Bello'), entrant('e3', 'Bob Carter')],
    )
    expect(rows.map((r) => r.displayName)).toEqual(['Aisha Bello', 'Bob Carter', 'Zoe Adams'])
  })

  it('prefers the entrant record over the raw payer name', () => {
    const rows = buildMasterRows(
      [payment({ entrant_id: 'e1', raw_payer_name: 'DANIEL J LASKOWSKI' })],
      [entrant('e1', 'Daniel Laskowski', { primary_email: 'dan@example.com' })],
    )
    expect(rows[0]!.displayName).toBe('Daniel Laskowski')
    expect(rows[0]!.email).toBe('dan@example.com')
  })
})

describe('summariseMaster', () => {
  it('totals across every source and status', () => {
    const rows = buildMasterRows(
      [
        payment({ entrant_id: 'e1', source: 'venmo', amount_cents: 5000, entries: 2 }),
        payment({ entrant_id: 'e2', source: 'zelle', amount_cents: 2500, entries: 1 }),
        payment({ entrant_id: 'e2', source: 'zelle', amount_cents: 2500, status: 'excluded' }),
        payment({ entrant_id: null, source: 'other', raw_payer_name: 'Who?', amount_cents: 2500, entries: 1 }),
      ],
      [entrant('e1', 'A B'), entrant('e2', 'C D')],
    )
    const s = summariseMaster(rows)
    expect(s.totalTickets).toBe(4)
    expect(s.approvedCents).toBe(10000)
    expect(s.excludedCents).toBe(2500)
    expect(s.excludedPayments).toBe(1)
    expect(s.bySource.venmo).toEqual({ payments: 1, cents: 5000 })
    expect(s.bySource.zelle).toEqual({ payments: 1, cents: 2500 })
    expect(s.bySource.other).toEqual({ payments: 1, cents: 2500 })
    expect(s.unassignedRows).toBe(1)
    expect(s.entrantCount).toBe(3)
  })

  it('reconciles: approved money equals tickets x price plus the remainder', () => {
    // The identity the operator checks against their bank statement.
    const price = 2500
    const rows = buildMasterRows(
      [
        payment({ entrant_id: 'e1', amount_cents: 6000, entries: 2, remainder_cents: 1000 }),
        payment({ entrant_id: 'e2', amount_cents: 10000, entries: 4, remainder_cents: 0 }),
      ],
      [entrant('e1', 'A B'), entrant('e2', 'C D')],
    )
    const s = summariseMaster(rows)
    expect(s.totalTickets * price + s.unallocatedCents).toBe(s.approvedCents)
  })
})

describe('oddsOneIn', () => {
  it('reports odds as a 1-in-N figure', () => {
    expect(oddsOneIn(1, 3000)).toBe(3000)
    expect(oddsOneIn(4, 3000)).toBe(750)
    expect(oddsOneIn(0, 3000)).toBeNull()
    expect(oddsOneIn(5, 0)).toBeNull()
  })

  it('keeps a decimal in a small pool so different ticket counts differ', () => {
    // Both of these round to 3 as whole numbers; on the master sheet that
    // would read as two people holding the same odds on different tickets.
    expect(oddsOneIn(4, 10)).toBe(2.5)
    expect(oddsOneIn(3, 10)).toBe(3.3)
    expect(oddsOneIn(2, 10)).toBe(5)
  })
})
