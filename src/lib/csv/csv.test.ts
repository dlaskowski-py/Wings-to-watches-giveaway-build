import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'

import { computeEntries, formatCents, parseAmountToCents } from './amount'
import { isWithinWindow, parseDate } from './dates'
import { assignRoles, detectHeaderRow, detectLayout, headerSignature } from './detect'
import {
  compareNames,
  emailMatchKey,
  extractPayerFromDescription,
  normalizeHandle,
  normalizeName,
  normalizePhone,
  toDisplayLabel,
} from './identity'
import {
  computeDedupeHash,
  looksLikeFormula,
  markDuplicates,
  normalizeRows,
  payerKeyFor,
  sanitizeForSpreadsheet,
} from './normalize'
import type { Grid } from './detect'

const TICKET = 2500

function grid(csv: string): Grid {
  return (Papa.parse<string[]>(csv.trim(), { skipEmptyLines: false }).data ?? []) as Grid
}

/* -------------------------------------------------------------------------- *
 * Amounts
 * -------------------------------------------------------------------------- */

describe('parseAmountToCents', () => {
  const good: Array<[string, number, boolean]> = [
    ['25', 2500, false],
    ['25.00', 2500, false],
    ['$25.00', 2500, false],
    ['$25', 2500, false],
    ['+ $25.00', 2500, false],
    ['+$25.00', 2500, false],
    ['- $25.00', 2500, true],
    ['-$25.00', 2500, true],
    ['($25.00)', 2500, true],
    ['(25.00)', 2500, true],
    ['1,250.00', 125000, false],
    ['$1,250.00', 125000, false],
    ['1,234,567.89', 123456789, false],
    ['25.00 USD', 2500, false],
    ['0.29', 29, false],
    ['0.01', 1, false],
    ['100', 10000, false],
    ['25.5', 2550, false],
    ['25.00-', 2500, true],
  ]

  it.each(good)('parses %s', (input, cents, negative) => {
    const r = parseAmountToCents(input)
    expect(r.ok, `expected "${input}" to parse`).toBe(true)
    if (!r.ok) return
    expect(r.value.cents).toBe(cents)
    expect(r.value.negative).toBe(negative)
  })

  it('handles the unicode whitespace and minus signs real exports contain', () => {
    // Non-breaking space between sign and amount; unicode minus.
    const nbsp = parseAmountToCents('+ $25.00')
    expect(nbsp.ok && nbsp.value.cents).toBe(2500)
    const uminus = parseAmountToCents('−$25.00')
    expect(uminus.ok && uminus.value.cents).toBe(2500)
    expect(uminus.ok && uminus.value.negative).toBe(true)
    const narrow = parseAmountToCents('$1 234.00')
    expect(narrow.ok).toBe(true)
  })

  it('never loses a cent to floating point', () => {
    // parseFloat("0.29") * 100 === 28.999999999999996
    for (const [input, expected] of [['0.29', 29], ['1.15', 115], ['19.99', 1999], ['1234.56', 123456]] as const) {
      const r = parseAmountToCents(input)
      expect(r.ok && r.value.cents).toBe(expected)
    }
  })

  it('accepts numeric input straight from the CSV parser', () => {
    const r = parseAmountToCents(25)
    expect(r.ok && r.value.cents).toBe(2500)
    const neg = parseAmountToCents(-25.5)
    expect(neg.ok && neg.value.cents).toBe(2550)
    expect(neg.ok && neg.value.negative).toBe(true)
  })

  it('rejects empties and placeholders rather than reading them as zero', () => {
    for (const input of ['', '   ', '--', 'N/A', 'n/a', 'none', 'null', '-']) {
      expect(parseAmountToCents(input).ok, `"${input}" should not parse`).toBe(false)
    }
  })

  it('rejects text that is not an amount', () => {
    for (const input of ['pending', 'abc', '12abc', '$$', '..']) {
      expect(parseAmountToCents(input).ok, `"${input}" should not parse`).toBe(false)
    }
  })

  it('flags a foreign currency instead of silently treating it as dollars', () => {
    const eur = parseAmountToCents('25.00 EUR')
    expect(eur.ok && eur.value.flags).toContain('non_usd_currency')
    const pound = parseAmountToCents('£25.00')
    expect(pound.ok && pound.value.flags).toContain('non_usd_currency')
    const usd = parseAmountToCents('25.00 USD')
    expect(usd.ok && usd.value.flags).not.toContain('non_usd_currency')
  })

  it('reads European 1.234,56 by taking the rightmost separator as the decimal', () => {
    const r = parseAmountToCents('1.234,56')
    expect(r.ok && r.value.cents).toBe(123456)
  })

  it('flags genuinely ambiguous separators rather than guessing quietly', () => {
    // "1,50" is $1.50 in Europe and a typo for $150 in the US. Parse, but flag.
    const r = parseAmountToCents('1,50')
    expect(r.ok && r.value.flags).toContain('ambiguous_separator')
  })

  it('flags more than two decimal places', () => {
    const r = parseAmountToCents('25.005')
    expect(r.ok && r.value.flags).toContain('excess_precision')
    expect(r.ok && r.value.cents).toBe(2500)
  })
})

describe('formatCents', () => {
  it('round-trips through the parser', () => {
    for (const cents of [0, 1, 99, 100, 2500, 123456, 100000000]) {
      const text = formatCents(cents)
      const back = parseAmountToCents(text)
      expect(back.ok && back.value.cents, `${cents} -> ${text}`).toBe(cents)
    }
  })
  it('formats correctly', () => {
    expect(formatCents(2500)).toBe('$25.00')
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(-2500)).toBe('-$25.00')
    expect(formatCents(2500, false)).toBe('25.00')
  })
})

describe('computeEntries', () => {
  it('rounds down and reports the remainder — the operator’s chosen rule', () => {
    expect(computeEntries(2500, TICKET, true)).toEqual({ entries: 1, remainderCents: 0 })
    expect(computeEntries(6000, TICKET, true)).toEqual({ entries: 2, remainderCents: 1000 })
    expect(computeEntries(10000, TICKET, true)).toEqual({ entries: 4, remainderCents: 0 })
    expect(computeEntries(2499, TICKET, true)).toEqual({ entries: 0, remainderCents: 2499 })
    expect(computeEntries(0, TICKET, true)).toEqual({ entries: 0, remainderCents: 0 })
  })
  it('never awards entries for outgoing money', () => {
    expect(computeEntries(10000, TICKET, false)).toEqual({ entries: 0, remainderCents: 0 })
  })
})

/* -------------------------------------------------------------------------- *
 * Dates
 * -------------------------------------------------------------------------- */

describe('parseDate', () => {
  it('parses the formats these exports actually use', () => {
    const cases: Array<[string, string]> = [
      ['2026-09-05', '2026-09-05'],
      ['2026-09-05T14:23:11Z', '2026-09-05'],
      ['2026-09-05 14:23:11', '2026-09-05'],
      ['09/05/2026', '2026-09-05'],
      ['9/5/2026', '2026-09-05'],
      ['09-05-2026', '2026-09-05'],
      ['09/05/26', '2026-09-05'],
      ['Sep 5, 2026', '2026-09-05'],
      ['September 5, 2026', '2026-09-05'],
      ['5 September 2026', '2026-09-05'],
      ['09/05/2026 2:23 PM', '2026-09-05'],
      ['2026-09-05T14:23:11-04:00', '2026-09-05'],
    ]
    for (const [input, expected] of cases) {
      const r = parseDate(input)
      expect(r.ok, `"${input}" should parse`).toBe(true)
      if (r.ok) expect(r.value.paidOn, input).toBe(expected)
    }
  })

  it('does NOT shift the calendar date across a timezone boundary', () => {
    // 8pm Eastern on the 5th is 00:23 UTC on the 6th. The payment happened on
    // the 5th and must stay on the 5th, or a window check moves it.
    const r = parseDate('2026-09-05T20:23:11-04:00')
    expect(r.ok && r.value.paidOn).toBe('2026-09-05')
  })

  it('defaults to US month-first but flags a genuinely ambiguous date', () => {
    const ambiguous = parseDate('03/04/2026')
    expect(ambiguous.ok && ambiguous.value.paidOn).toBe('2026-03-04')
    expect(ambiguous.ok && ambiguous.value.flags).toContain('ambiguous_date_order')
  })

  it('resolves the unambiguous case without flagging it', () => {
    const r = parseDate('25/12/2026') // 25 cannot be a month
    expect(r.ok && r.value.paidOn).toBe('2026-12-25')
    expect(r.ok && r.value.flags).not.toContain('ambiguous_date_order')
  })

  it('does not flag when both readings agree', () => {
    const r = parseDate('05/05/2026')
    expect(r.ok && r.value.flags).not.toContain('ambiguous_date_order')
  })

  it('honours an explicit day-first override', () => {
    const r = parseDate('03/04/2026', 'dmy')
    expect(r.ok && r.value.paidOn).toBe('2026-04-03')
  })

  it('expands two-digit years and says it assumed', () => {
    const r = parseDate('09/05/99')
    expect(r.ok && r.value.paidOn).toBe('1999-09-05')
    expect(r.ok && r.value.flags).toContain('assumed_century')
  })

  it('rejects impossible dates instead of rolling them over', () => {
    for (const bad of ['13/45/2026', '2026-02-30', '2026-13-01', 'not a date', '', '99/99/99']) {
      expect(parseDate(bad).ok, `"${bad}" should not parse`).toBe(false)
    }
  })

  it('handles leap years', () => {
    expect(parseDate('2024-02-29').ok).toBe(true)
    expect(parseDate('2026-02-29').ok).toBe(false)
  })
})

describe('isWithinWindow', () => {
  it('compares as plain strings, with no timezone involved', () => {
    expect(isWithinWindow('2026-07-15', '2026-07-01', '2026-09-30')).toBe(true)
    expect(isWithinWindow('2026-07-01', '2026-07-01', '2026-09-30')).toBe(true)
    expect(isWithinWindow('2026-09-30', '2026-07-01', '2026-09-30')).toBe(true)
    expect(isWithinWindow('2026-06-30', '2026-07-01', '2026-09-30')).toBe(false)
    expect(isWithinWindow('2026-10-01', '2026-07-01', '2026-09-30')).toBe(false)
    expect(isWithinWindow('2020-01-01', null, null)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- *
 * Identity
 * -------------------------------------------------------------------------- */

describe('identity normalisation', () => {
  it('folds accents, punctuation, case and titles to one key', () => {
    expect(normalizeName('Daniel Laskowski')).toBe('daniel laskowski')
    expect(normalizeName('  DANIEL   LASKOWSKI  ')).toBe('daniel laskowski')
    expect(normalizeName('Renée Dupont')).toBe('renee dupont')
    expect(normalizeName('Dr. Daniel Laskowski Jr.')).toBe('daniel laskowski')
    expect(normalizeName('Mary-Jane Smith')).toBe('mary jane smith')
  })

  it('treats straight and curly apostrophes identically', () => {
    // Before this was fixed, the curly form normalised to "o brien" and the
    // straight form to "o'brien", splitting one person into two entrants.
    expect(normalizeName("Sean O'Brien")).toBe(normalizeName('Sean O’Brien'))
    expect(normalizeName("Sean O'Brien")).toBe('sean obrien')
  })

  it('folds gmail dots and +tags, but only where the provider actually ignores them', () => {
    expect(emailMatchKey('Dan.Laskowski+raffle@gmail.com')).toBe('danlaskowski@gmail.com')
    expect(emailMatchKey('DAN@GMAIL.COM')).toBe('dan@gmail.com')
    // Dots are significant outside Gmail, so they must be preserved.
    expect(emailMatchKey('dan.l@company.com')).toBe('dan.l@company.com')
    expect(emailMatchKey('dan.l+tag@company.com')).toBe('dan.l@company.com')
    expect(emailMatchKey('not-an-email')).toBe('')
  })

  it('reduces US phone numbers to a comparable key', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('5551234567')
    expect(normalizePhone('555-123-4567')).toBe('5551234567')
    expect(normalizePhone('15551234567')).toBe('5551234567')
    expect(normalizePhone('5551234567')).toBe('5551234567')
    // Too short to identify anyone — better to have no key than a wrong one.
    expect(normalizePhone('1234')).toBe('')
    expect(normalizePhone('')).toBe('')
  })

  it('normalises handles', () => {
    expect(normalizeHandle('@Dan-Laskowski')).toBe('dan-laskowski')
    expect(normalizeHandle('Dan_L')).toBe('dan_l')
    expect(normalizeHandle('a')).toBe('')
  })

  it('builds a low-disclosure public label', () => {
    expect(toDisplayLabel('Daniel Laskowski')).toBe('Daniel L.')
    expect(toDisplayLabel('Daniel J Laskowski')).toBe('Daniel L.')
    expect(toDisplayLabel('Cher')).toBe('Cher')
    expect(toDisplayLabel('')).toBe('Unknown')
  })
})

describe('extractPayerFromDescription', () => {
  it('pulls the payer out of the description formats banks actually emit', () => {
    const cases: Array<[string, string]> = [
      ['ZELLE FROM JOHN SMITH ON 09/05', 'JOHN SMITH'],
      ['Zelle payment from JOHN SMITH 22001234567', 'JOHN SMITH'],
      ['Zelle payment from Jane Doe Conf# abc123', 'Jane Doe'],
      ['ZELLE CREDIT RECEIVED FROM MARIA GARCIA REF # 998', 'MARIA GARCIA'],
      ['ORIG CO NAME:ZELLE IND NAME:ROBERT J BROWN', 'ROBERT J BROWN'],
      ['ZELLE INSTANT PMT FROM PETER PARKER ON 07/02', 'PETER PARKER'],
    ]
    for (const [desc, expected] of cases) {
      const r = extractPayerFromDescription(desc)
      expect(r?.name, desc).toBe(expected)
      expect(r?.direction, desc).toBe('from')
    }
  })

  it('recognises outgoing payments so they are never counted as entries', () => {
    const r = extractPayerFromDescription('Zelle payment to VENDOR LLC')
    expect(r?.name).toBe('VENDOR LLC')
    expect(r?.direction).toBe('to')
  })

  it('returns null rather than inventing a name', () => {
    expect(extractPayerFromDescription('POS PURCHASE 1234')).toBeNull()
    expect(extractPayerFromDescription('')).toBeNull()
    expect(extractPayerFromDescription(null)).toBeNull()
  })
})

describe('compareNames', () => {
  it('scores an exact normalised match at 1', () => {
    expect(compareNames('Daniel Laskowski', 'daniel  laskowski').score).toBe(1)
  })

  it('suggests, but does not assert, short forms and initials', () => {
    const shortForm = compareNames('Dan Laskowski', 'Daniel Laskowski')
    expect(shortForm.score).toBeGreaterThanOrEqual(0.75)
    expect(shortForm.score).toBeLessThan(1)

    const initial = compareNames('D Laskowski', 'Daniel Laskowski')
    expect(initial.score).toBeGreaterThanOrEqual(0.75)
    expect(initial.score).toBeLessThan(1)
  })

  it('handles middle names and reversed order', () => {
    expect(compareNames('Daniel J Laskowski', 'Daniel Laskowski').score).toBeGreaterThanOrEqual(0.9)
    expect(compareNames('Laskowski Daniel', 'Daniel Laskowski').score).toBeGreaterThanOrEqual(0.9)
  })

  it('does NOT confuse two different people who share a surname', () => {
    const siblings = compareNames('Sarah Laskowski', 'Daniel Laskowski')
    expect(siblings.score).toBeLessThan(0.75)
  })

  it('keeps unrelated names well apart', () => {
    expect(compareNames('John Smith', 'Maria Garcia').score).toBeLessThan(0.5)
  })
})

/* -------------------------------------------------------------------------- *
 * Layout detection
 * -------------------------------------------------------------------------- */

// A Venmo statement export: several preamble rows, a blank spacer, the real
// header, then data, then the running-balance footer row.
const VENMO_CSV = `
Account Statement - (@wings-to-watches)
,,,,,,,,,
Account Activity,,,,,,,,,
,,,,,,,,,
,ID,Datetime,Type,Status,Note,From,To,Amount (total),Amount (fee)
,,,,,,,,Beginning Balance,$0.00
,4210987654321,2026-07-02T14:23:11,Payment,Complete,Q3 raffle,Michael Chen,Wings to Watches,+ $50.00,
,4210987654322,2026-07-05T09:01:44,Payment,Complete,4 tickets please,Sarah Johnson,Wings to Watches,+ $100.00,
,4210987654323,2026-07-06T18:55:02,Payment,Complete,raffle,Dave Rodriguez,Wings to Watches,+ $25.00,
,4210987654324,2026-07-08T11:12:00,Payment,Complete,partial,Emily Nguyen,Wings to Watches,+ $60.00,
,4210987654325,2026-07-09T08:00:00,Charge,Complete,refund,Wings to Watches,Michael Chen,- $25.00,
,,,,,,,,Ending Balance,$210.00
`

describe('detectHeaderRow', () => {
  it('skips a Venmo preamble and finds the real header row', () => {
    const g = grid(VENMO_CSV)
    const idx = detectHeaderRow(g)
    expect(g[idx]).toContain('Datetime')
    expect(g[idx]).toContain('Amount (total)')
  })

  it('finds a header on row 0 when there is no preamble', () => {
    const g = grid(`Date,Description,Amount\n2026-07-02,ZELLE FROM A B,25.00`)
    expect(detectHeaderRow(g)).toBe(0)
  })
})

describe('detectLayout', () => {
  it('maps a Venmo export end to end', () => {
    const { mapping, headers, dataRows, confidence } = detectLayout(grid(VENMO_CSV))
    expect(headers).toContain('Datetime')
    expect(mapping.source).toBe('venmo')
    expect(mapping.roles.date).toBe(headers.indexOf('Datetime'))
    expect(mapping.roles.amount).toBe(headers.indexOf('Amount (total)'))
    expect(mapping.roles.payer_name).toBe(headers.indexOf('From'))
    expect(mapping.roles.note).toBe(headers.indexOf('Note'))
    expect(mapping.roles.status).toBe(headers.indexOf('Status'))
    expect(mapping.directionMode).toBe('sign')
    expect(confidence).toBeGreaterThan(0.7)
    // Balance rows have no usable date/amount pairing but are still present here;
    // normalizeRows is what rejects them.
    expect(dataRows.length).toBeGreaterThan(5)
  })

  it('does not mistake the "To" column for the payer', () => {
    const { mapping, headers } = detectLayout(grid(VENMO_CSV))
    expect(mapping.roles.payer_name).not.toBe(headers.indexOf('To'))
  })

  it('maps a bank-style Zelle export with a description column', () => {
    const csv = `
Details,Posting Date,Description,Amount,Type,Balance
CREDIT,07/02/2026,Zelle payment from MICHAEL CHEN 22001234567,50.00,ACH_CREDIT,1050.00
CREDIT,07/05/2026,Zelle payment from SARAH JOHNSON 22001234568,100.00,ACH_CREDIT,1150.00
DEBIT,07/09/2026,Zelle payment to VENDOR LLC,-25.00,ACH_DEBIT,1125.00
`
    const { mapping, headers } = detectLayout(grid(csv))
    expect(mapping.roles.date).toBe(headers.indexOf('Posting Date'))
    expect(mapping.roles.description).toBe(headers.indexOf('Description'))
    expect(mapping.roles.amount).toBe(headers.indexOf('Amount'))
    expect(mapping.directionMode).toBe('sign')
  })

  it('detects separate credit and debit columns', () => {
    const csv = `
Date,Description,Debit,Credit,Balance
07/02/2026,ZELLE FROM MICHAEL CHEN ON 07/02,,50.00,1050.00
07/09/2026,ZELLE TO VENDOR LLC,25.00,,1025.00
`
    const { mapping, headers } = detectLayout(grid(csv))
    expect(mapping.roles.credit).toBe(headers.indexOf('Credit'))
    expect(mapping.roles.debit).toBe(headers.indexOf('Debit'))
    expect(mapping.directionMode).toBe('credit_debit')
  })

  it('prefers the amount column over a fee column', () => {
    const headers = ['Date', 'Amount (fee)', 'Amount (total)']
    const rows: Grid = [['2026-07-02', '0.00', '25.00'], ['2026-07-03', '0.00', '50.00']]
    const roles = assignRoles(headers, rows)
    expect(roles.amount).toBe(2)
  })

  it('produces a stable header signature regardless of column order or case', () => {
    expect(headerSignature(['Date', 'Amount', 'From'])).toBe(headerSignature(['from', 'DATE', ' amount ']))
    expect(headerSignature(['Date', 'Amount'])).not.toBe(headerSignature(['Date', 'Total']))
  })
})

/* -------------------------------------------------------------------------- *
 * Normalisation end to end
 * -------------------------------------------------------------------------- */

describe('normalizeRows — Venmo', () => {
  it('turns a Venmo export into reviewable payments with correct entries', async () => {
    const { mapping, headers, dataRows } = detectLayout(grid(VENMO_CSV))
    const preview = await normalizeRows(headers, dataRows, {
      mapping,
      ticketPriceCents: TICKET,
      windowStart: '2026-07-01',
      windowEnd: '2026-09-30',
    })

    const byName = new Map(preview.rows.map((r) => [r.rawPayerName, r]))

    expect(byName.get('Michael Chen')?.entries).toBe(2)
    expect(byName.get('Sarah Johnson')?.entries).toBe(4)
    expect(byName.get('Dave Rodriguez')?.entries).toBe(1)

    // $60 -> 2 entries with $10 flagged, exactly the operator's chosen rule.
    const emily = byName.get('Emily Nguyen')!
    expect(emily.entries).toBe(2)
    expect(emily.remainderCents).toBe(1000)
    expect(emily.flags).toContain('partial_amount')

    // The refund is outgoing and earns nothing.
    const refund = preview.rows.find((r) => r.direction === 'out')!
    expect(refund.entries).toBe(0)
    expect(refund.flags).toContain('outgoing')

    // Beginning/Ending Balance rows carry no readable amount pairing and are rejected.
    expect(preview.rows.every((r) => r.rawPayerName !== null || r.flags.includes('missing_payer'))).toBe(true)

    expect(preview.totals.totalEntries).toBe(9) // 2 + 4 + 1 + 2
    expect(preview.totals.incomingCount).toBe(4)
    expect(preview.totals.outgoingCount).toBe(1)
    expect(preview.totals.totalCents).toBe(23500) // 50 + 100 + 25 + 60
    expect(preview.totals.unallocatedCents).toBe(1000)
  })

  it('captures the transaction id so re-importing cannot double-count', async () => {
    const { mapping, headers, dataRows } = detectLayout(grid(VENMO_CSV))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    const michael = preview.rows.find((r) => r.rawPayerName === 'Michael Chen')!
    expect(michael.externalRef).toBe('4210987654321')
  })
})

describe('normalizeRows — bank-style Zelle', () => {
  const CHASE_CSV = `
Details,Posting Date,Description,Amount,Type,Balance
CREDIT,07/02/2026,Zelle payment from MICHAEL CHEN 22001234567,50.00,ACH_CREDIT,1050.00
CREDIT,07/05/2026,Zelle payment from SARAH JOHNSON 22001234568,100.00,ACH_CREDIT,1150.00
DEBIT,07/09/2026,Zelle payment to VENDOR LLC,-25.00,ACH_DEBIT,1125.00
CREDIT,07/11/2026,ATM DEPOSIT,200.00,DEPOSIT,1325.00
`

  it('extracts payer names out of the description and flags them for confirmation', async () => {
    const { mapping, headers, dataRows } = detectLayout(grid(CHASE_CSV))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })

    const michael = preview.rows.find((r) => r.rawPayerName === 'MICHAEL CHEN')!
    expect(michael.entries).toBe(2)
    expect(michael.flags).toContain('name_from_description')

    // Outgoing Zelle is detected from BOTH the minus sign and the "to" wording.
    const vendor = preview.rows.find((r) => r.rawPayerName === 'VENDOR LLC')!
    expect(vendor.direction).toBe('out')
    expect(vendor.entries).toBe(0)

    // A non-Zelle deposit has no identifiable payer and must be flagged, not
    // silently credited to nobody.
    const atm = preview.rows.find((r) => r.rawRow.Description === 'ATM DEPOSIT')!
    expect(atm.flags).toContain('missing_payer')
  })

  it('reads separate credit/debit columns', async () => {
    const csv = `
Date,Description,Debit,Credit,Balance
07/02/2026,ZELLE FROM MICHAEL CHEN ON 07/02,,50.00,1050.00
07/09/2026,ZELLE TO VENDOR LLC,25.00,,1025.00
`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    expect(preview.rows[0]!.direction).toBe('in')
    expect(preview.rows[0]!.amountCents).toBe(5000)
    expect(preview.rows[0]!.entries).toBe(2)
    expect(preview.rows[1]!.direction).toBe('out')
    expect(preview.rows[1]!.entries).toBe(0)
  })
})

describe('window and status flags', () => {
  it('flags payments outside the drawing window instead of dropping them', async () => {
    const csv = `
Date,From,Amount,Status
2026-06-15,Early Bird,25.00,Complete
2026-07-15,On Time,25.00,Complete
2026-10-15,Late Payer,25.00,Complete
`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, {
      mapping, ticketPriceCents: TICKET, windowStart: '2026-07-01', windowEnd: '2026-09-30',
    })
    expect(preview.rows).toHaveLength(3)
    expect(preview.rows[0]!.flags).toContain('outside_window')
    expect(preview.rows[1]!.flags).not.toContain('outside_window')
    expect(preview.rows[2]!.flags).toContain('outside_window')
  })

  it('flags failed and pending transactions', async () => {
    const csv = `
Date,From,Amount,Status
2026-07-15,Good Payer,25.00,Complete
2026-07-16,Failed Payer,25.00,Failed
2026-07-17,Pending Payer,25.00,Pending
`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    expect(preview.rows[0]!.flags).not.toContain('failed_status')
    expect(preview.rows[1]!.flags).toContain('failed_status')
    expect(preview.rows[2]!.flags).toContain('failed_status')
  })

  it('flags an amount below one ticket', async () => {
    const csv = `Date,From,Amount\n2026-07-15,Tiny Payer,10.00`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    expect(preview.rows[0]!.entries).toBe(0)
    expect(preview.rows[0]!.flags).toContain('zero_entries')
  })

  it('flags an unusually large amount', async () => {
    const csv = `Date,From,Amount\n2026-07-15,Big Spender,5000.00`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    expect(preview.rows[0]!.entries).toBe(200)
    expect(preview.rows[0]!.flags).toContain('large_amount')
  })
})

/* -------------------------------------------------------------------------- *
 * Dedupe
 * -------------------------------------------------------------------------- */

describe('dedupe', () => {
  it('gives the same hash to the same transaction id', async () => {
    const base = { source: 'venmo', externalRef: 'TX-1', paidOn: '2026-07-02', amountCents: 2500, direction: 'in', payerKey: 'name:a b', note: 'x' }
    const a = await computeDedupeHash(base)
    // Even if every other field differs, the same id is the same payment.
    const b = await computeDedupeHash({ ...base, note: 'totally different', paidOn: '2026-08-02' })
    expect(b).toBe(a)
  })

  it('falls back to content hashing when there is no transaction id', async () => {
    const base = { source: 'zelle', externalRef: null, paidOn: '2026-07-02', amountCents: 2500, direction: 'in', payerKey: 'name:a b', note: 'raffle' }
    const a = await computeDedupeHash(base)
    expect(await computeDedupeHash({ ...base })).toBe(a)
    expect(await computeDedupeHash({ ...base, amountCents: 5000 })).not.toBe(a)
    expect(await computeDedupeHash({ ...base, paidOn: '2026-07-03' })).not.toBe(a)
    expect(await computeDedupeHash({ ...base, payerKey: 'name:c d' })).not.toBe(a)
    expect(await computeDedupeHash({ ...base, direction: 'out' })).not.toBe(a)
  })

  it('ignores note whitespace and case, which vary between exports', async () => {
    const base = { source: 'zelle', externalRef: null, paidOn: '2026-07-02', amountCents: 2500, direction: 'in', payerKey: 'name:a b', note: 'Q3  Raffle' }
    expect(await computeDedupeHash({ ...base, note: 'q3 raffle' })).toBe(await computeDedupeHash(base))
  })

  it('catches a re-imported overlapping export without touching the originals', async () => {
    const { mapping, headers, dataRows } = detectLayout(grid(VENMO_CSV))
    const first = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })

    const existing = new Set(first.rows.map((r) => r.dedupeHash))
    const second = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    const marked = markDuplicates(second.rows, existing)

    expect(marked.duplicateCount).toBe(second.rows.length)
    expect(marked.rows.every((r) => r.flags.includes('duplicate_suspected'))).toBe(true)

    // The first import is untouched.
    expect(first.rows.every((r) => !r.flags.includes('duplicate_suspected'))).toBe(true)
  })

  it('flags only the SECOND of two identical rows in one file', async () => {
    const csv = `
Date,From,Amount,Note
2026-07-15,Repeat Payer,25.00,raffle
2026-07-15,Repeat Payer,25.00,raffle
`
    const { mapping, headers, dataRows } = detectLayout(grid(csv))
    const preview = await normalizeRows(headers, dataRows, { mapping, ticketPriceCents: TICKET })
    const marked = markDuplicates(preview.rows, new Set())
    expect(marked.duplicateCount).toBe(1)
    expect(marked.rows[0]!.flags).not.toContain('duplicate_suspected')
    expect(marked.rows[1]!.flags).toContain('duplicate_suspected')
  })

  it('prefers the strongest identity signal available for the payer key', () => {
    expect(payerKeyFor({ email: 'a@gmail.com', phone: '5551234567', name: 'A B' })).toBe('email:a@gmail.com')
    expect(payerKeyFor({ phone: '555-123-4567', name: 'A B' })).toBe('phone:5551234567')
    expect(payerKeyFor({ handle: '@dan-l', name: 'A B' })).toBe('handle:dan-l')
    expect(payerKeyFor({ name: 'Daniel Laskowski' })).toBe('name:daniel laskowski')
    expect(payerKeyFor({})).toBe('unknown')
  })
})

/* -------------------------------------------------------------------------- *
 * Spreadsheet formula injection
 * -------------------------------------------------------------------------- */

describe('sanitizeForSpreadsheet', () => {
  it('neutralises every formula-triggering prefix', () => {
    for (const payload of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '=cmd|\'/c calc\'!A1', '=HYPERLINK("http://evil","x")']) {
      expect(sanitizeForSpreadsheet(payload).startsWith("'"), payload).toBe(true)
    }
  })

  it('is not fooled by leading whitespace, which Excel trims before evaluating', () => {
    expect(sanitizeForSpreadsheet('   =1+1').startsWith("'")).toBe(true)
    expect(sanitizeForSpreadsheet(' =1+1').startsWith("'")).toBe(true)
  })

  it('leaves ordinary notes alone', () => {
    for (const safe of ['Q3 raffle', '4 tickets', 'thanks!', '25 dollars', '']) {
      expect(sanitizeForSpreadsheet(safe)).toBe(safe)
    }
  })

  it('detects formula-looking notes so they can be flagged on import', () => {
    expect(looksLikeFormula('=cmd|calc!A1')).toBe(true)
    expect(looksLikeFormula('Q3 raffle')).toBe(false)
    expect(looksLikeFormula('-25 refund')).toBe(false)
  })
})
