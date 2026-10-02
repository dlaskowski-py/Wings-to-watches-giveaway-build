import { describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { detectLayout } from './detect'
import { extractPayerFromDescription } from './identity'
import { normalizeRows } from './normalize'
import type { Grid } from './detect'

/**
 * Bank of America Zelle exports.
 *
 * Zelle inside a bank is not a Zelle export — you get the BANK's statement, so
 * three things differ from a standalone Zelle file and each one has broken a
 * parser before:
 *
 *  1. A summary preamble sits above the real header row.
 *  2. There is a running-balance column, which is the trap that once made a
 *     Chase balance read as the payment amount ($1,050 -> 42 tickets).
 *  3. The payer is INSIDE the description, not in a column of its own, and the
 *     description often carries the payer's memo after the name.
 */
const BOFA = `Description,,Summary Amt.
Beginning balance as of 07/01/2026,,"2,450.18"
Total credits,,"1,275.00"
Total debits,,"-310.42"
Ending balance as of 09/30/2026,,"3,414.76"

Date,Description,Amount,Running Bal.
07/02/2026,"Zelle payment from JOHN SMITH Conf# a1b2c3d4e",25.00,"2,475.18"
07/05/2026,"Zelle payment from MARIA GARCIA-LOPEZ for Q3 raffle Conf# 9f8e7d6c",50.00,"2,525.18"
07/11/2026,"Zelle payment from ROBERT O'BRIEN Conf# 11223344",25.00,"2,550.18"
07/19/2026,"Zelle payment from ANNA FORD for 4 tickets Conf# 7a7a7a",100.00,"2,650.18"
07/23/2026,"Zelle payment from PRIYA PATEL; Conf# 5c5c5c",25.00,"2,675.18"
08/03/2026,"Online Banking transfer from CHEN DAVID Conf# 90909090",25.00,"2,700.18"
08/14/2026,"ZELLE PAYMENT FROM DAVID CHEN ON 08/14 CONF# AABBCC",75.00,"2,775.18"
08/20/2026,"Zelle payment to ACME SUPPLY LLC Conf# deadbeef",-310.42,"2,464.76"
09/01/2026,"CHECKCARD 0812 STARBUCKS STORE 1234",-6.45,"2,458.31"
09/15/2026,"Zelle payment from SARAH JOHNSON Conf# 55667788","1,000.00","3,458.31"
`

const grid = (csv: string): Grid =>
  (Papa.parse<string[]>(csv.trim(), { skipEmptyLines: false }).data ?? []) as Grid

async function parse() {
  const { mapping, headers, dataRows } = detectLayout(grid(BOFA))
  const preview = await normalizeRows(headers, dataRows, {
    mapping,
    ticketPriceCents: 2500,
    windowStart: '2026-07-01',
    windowEnd: '2026-09-30',
  })
  return { mapping, headers, preview }
}

describe('Bank of America statement layout', () => {
  it('finds the real header below the summary preamble', async () => {
    const { headers } = await parse()
    expect(headers).toEqual(['Date', 'Description', 'Amount', 'Running Bal.'])
  })

  it('never mistakes the running balance for the payment amount', async () => {
    const { mapping, preview } = await parse()
    // The balance column must claim no role at all.
    expect(Object.values(mapping.roles)).not.toContain(3)
    expect(mapping.roles.amount).toBe(2)
    // If the balance were read as the amount, the first row would be 2475.18.
    expect(preview.rows[0]!.amountCents).toBe(2500)
  })

  it('reads the payer out of the description, since there is no payer column', async () => {
    const { mapping, preview } = await parse()
    expect(mapping.roles.payer_name).toBeUndefined()
    expect(preview.rows.map((r) => r.payerName)).toEqual([
      'JOHN SMITH',
      'MARIA GARCIA-LOPEZ',
      "ROBERT O'BRIEN",
      'ANNA FORD',
      'PRIYA PATEL',
      'CHEN DAVID',
      'DAVID CHEN',
      'ACME SUPPLY LLC',
      null, // a card purchase, which carries no counterparty name
      'SARAH JOHNSON',
    ])
  })

  it('counts tickets only on money coming in', async () => {
    const { preview } = await parse()
    const byPayer = new Map(preview.rows.map((r) => [r.payerName, r]))
    expect(byPayer.get('JOHN SMITH')!.entries).toBe(1)
    expect(byPayer.get('ANNA FORD')!.entries).toBe(4)
    // Outgoing rows earn nothing, whoever they name.
    expect(byPayer.get('ACME SUPPLY LLC')!.direction).toBe('out')
    expect(byPayer.get('ACME SUPPLY LLC')!.entries).toBe(0)
    expect(preview.rows.filter((r) => r.direction === 'out').every((r) => r.entries === 0)).toBe(true)
  })

  it('parses amounts carrying thousands separators', async () => {
    const { preview } = await parse()
    const sarah = preview.rows.find((r) => r.payerName === 'SARAH JOHNSON')!
    expect(sarah.amountCents).toBe(100_000)
    expect(sarah.entries).toBe(40)
  })
})

describe('payer extraction from a bank description', () => {
  it('stops at the memo the payer typed', () => {
    // Without a stop at FOR the capture reaches for the memo, and because the
    // name class excludes digits, "for Q3 raffle" makes the match fail outright.
    expect(extractPayerFromDescription('Zelle payment from MARIA GARCIA-LOPEZ for Q3 raffle Conf# 9f')?.name)
      .toBe('MARIA GARCIA-LOPEZ')
    expect(extractPayerFromDescription('Zelle payment from JOHN SMITH for tickets')?.name)
      .toBe('JOHN SMITH')
  })

  it('does not eat a surname that merely starts with a stop word', () => {
    // " FORD" matches "\s+FOR" unless every stop word carries its own \b, and a
    // truncated surname silently becomes a second entrant with its own tickets.
    for (const [desc, want] of [
      ['Zelle payment from ANNA FORD Conf# 7a', 'ANNA FORD'],
      ['Zelle payment from LIAM FORSTER Conf# 7a', 'LIAM FORSTER'],
      ['Zelle payment from MIA FORTUNA for 2 tickets Conf# 7a', 'MIA FORTUNA'],
      ['Zelle payment from SAM ONEILL Conf# 7a', 'SAM ONEILL'],
      ['Zelle payment from IVY REFSNES Conf# 7a', 'IVY REFSNES'],
    ] as const) {
      expect(extractPayerFromDescription(desc)?.name, desc).toBe(want)
    }
  })

  it('handles the punctuation and casing banks vary on', () => {
    expect(extractPayerFromDescription('Zelle payment from PRIYA PATEL; Conf# 5c')?.name).toBe('PRIYA PATEL')
    expect(extractPayerFromDescription('ZELLE PAYMENT FROM DAVID CHEN ON 08/14 CONF# AB')?.name).toBe('DAVID CHEN')
    expect(extractPayerFromDescription("Zelle payment from ROBERT O'BRIEN Conf# 11")?.name).toBe("ROBERT O'BRIEN")
  })

  it('reads direction from the wording, not just the sign', () => {
    expect(extractPayerFromDescription('Zelle payment to ACME SUPPLY LLC Conf# de')?.direction).toBe('to')
    expect(extractPayerFromDescription('Zelle payment from JOHN SMITH Conf# a1')?.direction).toBe('from')
  })
})
