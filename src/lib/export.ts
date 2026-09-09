/**
 * Exports.
 *
 * The operator thinks in spreadsheets ("let me verify the entire excel"), so
 * every screen that shows numbers can hand them a file containing exactly what
 * is on screen — same rows, same order, same filters applied.
 *
 * Everything user-supplied is passed through `sanitizeForSpreadsheet` on the way
 * out. A payer can type `=HYPERLINK(...)` into a Venmo note; that text is inert
 * in the browser, but Excel would evaluate it the moment the operator opens the
 * downloaded file.
 */
import writeXlsxFile, { type Column } from 'write-excel-file/browser'
import { formatCents } from './csv/amount'
import { sanitizeForSpreadsheet } from './csv/normalize'
import type { Drawing, Entrant, Payment, DrawResultRow, SnapshotEntry } from './types'
import { buildMasterRows, oddsOneIn, summariseMaster, type MasterRow } from './master'
import { BRAND } from '../components/brand'

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Revoke on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** RFC 4180 quoting, plus formula neutralisation. */
function csvCell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : String(value)
  const safe = sanitizeForSpreadsheet(raw)
  return `"${safe.replace(/"/g, '""')}"`
}

export function downloadCsv(
  fileName: string,
  headers: string[],
  rows: unknown[][],
  preamble: unknown[][] = [],
): void {
  const lines = [
    ...preamble.map((r) => r.map(csvCell).join(',')),
    headers.map(csvCell).join(','),
    ...rows.map((r) => r.map(csvCell).join(',')),
  ]
  // BOM so Excel opens UTF-8 correctly on Windows.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  triggerDownload(blob, fileName)
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drawing'
}

/* -------------------------------------------------------------------------- *
 * The payment ledger — the "excel" the operator verifies
 * -------------------------------------------------------------------------- */

export interface LedgerRow {
  payment: Payment
  entrantName: string | null
}

const LEDGER_HEADERS = [
  'Row', 'Date', 'Payer (as written)', 'Matched entrant', 'Source', 'Direction',
  'Amount', 'Entries', 'Unallocated', 'Status', 'Flags', 'Note', 'Transaction ID', 'Exclude reason',
]

function ledgerValues(row: LedgerRow): unknown[] {
  const p = row.payment
  return [
    p.source_row_number ?? '',
    p.paid_on ?? '',
    p.raw_payer_name ?? p.payer_name ?? '',
    row.entrantName ?? '',
    p.source,
    p.direction === 'in' ? 'Money in' : 'Money out',
    formatCents(p.amount_cents, false),
    p.entries,
    p.remainder_cents > 0 ? formatCents(p.remainder_cents, false) : '',
    p.status,
    p.flags.join(', '),
    p.note ?? '',
    p.external_ref ?? '',
    p.exclude_reason ?? '',
  ]
}

export function exportLedgerCsv(drawing: Drawing, rows: LedgerRow[]): void {
  downloadCsv(`${slug(drawing.name)}-payments.csv`, LEDGER_HEADERS, rows.map(ledgerValues))
}

export async function exportLedgerXlsx(drawing: Drawing, rows: LedgerRow[]): Promise<void> {
  // Money and entry counts are written as real numbers so the operator can sum
  // them in Excel and tie the total out against their bank statement; that is
  // the whole reason they asked for a spreadsheet rather than a screenshot.
  // Everything else goes out as formula-neutralised text.
  const text = (value: string | null | undefined) => ({
    value: sanitizeForSpreadsheet(value ?? ''),
    type: String,
  })

  const schema: Array<Column<LedgerRow>> = [
    { header: { value: 'Row', fontWeight: 'bold' }, width: 7,
      cell: (r) =>
        r.payment.source_row_number === null
          ? { type: Number }
          : { value: r.payment.source_row_number, type: Number } },
    { header: { value: 'Date', fontWeight: 'bold' }, width: 12,
      cell: (r) => text(r.payment.paid_on) },
    { header: { value: 'Payer (as written)', fontWeight: 'bold' }, width: 24,
      cell: (r) => text(r.payment.raw_payer_name ?? r.payment.payer_name) },
    { header: { value: 'Matched entrant', fontWeight: 'bold' }, width: 22,
      cell: (r) => text(r.entrantName) },
    { header: { value: 'Source', fontWeight: 'bold' }, width: 9,
      cell: (r) => text(r.payment.source) },
    { header: { value: 'Direction', fontWeight: 'bold' }, width: 11,
      cell: (r) => text(r.payment.direction === 'in' ? 'Money in' : 'Money out') },
    { header: { value: 'Amount', fontWeight: 'bold' }, width: 12,
      cell: (r) => ({ value: r.payment.amount_cents / 100, type: Number, format: '#,##0.00' }) },
    { header: { value: 'Entries', fontWeight: 'bold' }, width: 9,
      cell: (r) => ({ value: r.payment.entries, type: Number }) },
    { header: { value: 'Unallocated', fontWeight: 'bold' }, width: 12,
      // Left blank rather than zero: a 0 in this column reads as "checked and
      // nothing left over", which is exactly the distinction the operator cares
      // about when hunting for partial payments.
      cell: (r) =>
        r.payment.remainder_cents > 0
          ? { value: r.payment.remainder_cents / 100, type: Number, format: '#,##0.00' }
          : { type: Number } },
    { header: { value: 'Status', fontWeight: 'bold' }, width: 14,
      cell: (r) => text(r.payment.status) },
    { header: { value: 'Flags', fontWeight: 'bold' }, width: 34,
      cell: (r) => text(r.payment.flags.join(', ')) },
    { header: { value: 'Note', fontWeight: 'bold' }, width: 30,
      cell: (r) => text(r.payment.note) },
    { header: { value: 'Transaction ID', fontWeight: 'bold' }, width: 20,
      cell: (r) => text(r.payment.external_ref) },
    { header: { value: 'Exclude reason', fontWeight: 'bold' }, width: 22,
      cell: (r) => text(r.payment.exclude_reason) },
  ]

  const blob = await writeXlsxFile(rows, {
    columns: schema,
    sheet: 'Payments',
    stickyRowsCount: 1,
  }).toBlob()

  triggerDownload(blob, `${slug(drawing.name)}-payments.xlsx`)
}

/* -------------------------------------------------------------------------- *
 * Entrants and tickets
 * -------------------------------------------------------------------------- */

export function exportEntrantsCsv(
  drawing: Drawing,
  rows: Array<{ entrant: Entrant; tickets: number; paidCents: number; paymentCount: number }>,
): void {
  downloadCsv(
    `${slug(drawing.name)}-entrants.csv`,
    ['Name', 'Public label', 'Email', 'Phone', 'Payments', 'Total paid', 'Tickets'],
    rows.map((r) => [
      r.entrant.display_name,
      r.entrant.display_label,
      r.entrant.primary_email ?? '',
      r.entrant.primary_phone ?? '',
      r.paymentCount,
      formatCents(r.paidCents, false),
      r.tickets,
    ]),
  )
}

/* -------------------------------------------------------------------------- *
 * The published record
 *
 * Everything a group member needs to verify the draw themselves, in one file:
 * the commitment, the frozen entrant list, and the winners.
 * -------------------------------------------------------------------------- */

export function exportVerificationRecord(
  drawing: Drawing,
  snapshot: SnapshotEntry[],
  results: DrawResultRow[],
): void {
  const lines: string[] = [
    `Wings to Watches — ${drawing.name}`,
    '',
    'COMMITMENT (published before the draw)',
    `  Entrant list hash : ${drawing.snapshot_hash ?? '—'}`,
    `  Seed commitment   : ${drawing.seed_commitment ?? '—'}`,
    `  Beacon chain      : ${drawing.beacon_chain ?? '—'}`,
    `  Beacon round      : ${drawing.beacon_round ?? '—'}`,
    `  Locked at         : ${drawing.locked_at ?? '—'}`,
    '',
    'REVEAL (published after the draw)',
    `  Beacon randomness : ${drawing.beacon_randomness ?? '—'}`,
    `  Revealed seed     : ${drawing.revealed_seed ?? '—'}`,
    `  Final seed        : ${drawing.final_seed ?? '—'}`,
    `  Drawn at          : ${drawing.drawn_at ?? '—'}`,
    '',
    `HOW TO CHECK IT YOURSELF`,
    `  1. Fetch the beacon:  https://api.drand.sh/${drawing.beacon_chain ?? ''}/public/${drawing.beacon_round ?? ''}`,
    `     Confirm its "randomness" equals the value above.`,
    `  2. Open the verification page and press "Re-run the draw".`,
    `     It recomputes the winners in your own browser from these values.`,
    '',
    `FROZEN ENTRANT LIST (${snapshot.length} entrants, ${snapshot.reduce((s, e) => s + e.tickets, 0)} tickets)`,
    ...snapshot.map((e) => `  ${e.public_id}  ${String(e.tickets).padStart(4)}  ${e.display_label}`),
    '',
    'RESULT',
    ...results.map(
      (r) => `  #${r.rank}  ${r.is_alternate ? 'alternate' : 'WINNER   '}  ${r.display_label} (${r.tickets} tickets)`,
    ),
    '',
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
  triggerDownload(blob, `${slug(drawing.name)}-verification.txt`)
}

/* -------------------------------------------------------------------------- *
 * The master export
 *
 * One row per person, combining Venmo and Zelle. This is the file to keep: the
 * ledger lists payments, this says what each human actually did across both
 * rails, which is the only view in which a ticket count can be sanity-checked
 * by eye.
 * -------------------------------------------------------------------------- */

const MASTER_HEADERS = [
  'Entrant', 'Public label', 'Email', 'Phone',
  'Venmo payments', 'Venmo paid', 'Zelle payments', 'Zelle paid', 'Other payments', 'Other paid',
  'Total paid', 'Tickets', 'Odds (1 in)', 'Unallocated',
  'Excluded payments', 'Excluded amount', 'Duplicates', 'Awaiting review', 'Outgoing',
  'First payment', 'Last payment', 'Flags', 'Matched',
]

function masterValues(r: MasterRow, totalTickets: number): unknown[] {
  const odds = oddsOneIn(r.tickets, totalTickets)
  return [
    r.displayName, r.displayLabel, r.email ?? '', r.phone ?? '',
    r.bySource.venmo.payments, formatCents(r.bySource.venmo.cents, false),
    r.bySource.zelle.payments, formatCents(r.bySource.zelle.cents, false),
    r.bySource.other.payments + r.bySource.manual.payments,
    formatCents(r.bySource.other.cents + r.bySource.manual.cents, false),
    formatCents(r.approvedCents, false), r.tickets, odds ?? '',
    r.unallocatedCents > 0 ? formatCents(r.unallocatedCents, false) : '',
    r.excludedPayments || '', r.excludedCents > 0 ? formatCents(r.excludedCents, false) : '',
    r.duplicatePayments || '', r.pendingPayments || '', r.outgoingPayments || '',
    r.firstPaidOn ?? '', r.lastPaidOn ?? '', r.flags.join(', '),
    r.unassigned ? 'NO — unmatched payer' : 'yes',
  ]
}

/**
 * Master CSV.
 *
 * Opens with a short provenance block — which drawing, when, the reconciliation
 * identity — so the file still explains itself when it is opened months later
 * with no memory of where it came from. The blank line before the header keeps
 * spreadsheets from folding the preamble into the table.
 */
export function exportMasterCsv(drawing: Drawing, payments: Payment[], entrants: Entrant[]): void {
  const rows = buildMasterRows(payments, entrants)
  const summary = summariseMaster(rows)
  const expected = summary.totalTickets * drawing.ticket_price_cents + summary.unallocatedCents

  const preamble: unknown[][] = [
    [`${drawing.name} — master record`],
    [BRAND.full, BRAND.motto],
    ['Exported', new Date().toISOString()],
    ['Ticket price', formatCents(drawing.ticket_price_cents, false)],
    ['Entrants with tickets', summary.entrantCount, 'Total tickets', summary.totalTickets],
    ['Approved money in', formatCents(summary.approvedCents, false),
      'Tickets x price + unallocated', formatCents(expected, false),
      expected === summary.approvedCents ? 'RECONCILES' : 'DOES NOT RECONCILE — investigate'],
    ['Venmo', formatCents(summary.bySource.venmo.cents, false),
      'Zelle', formatCents(summary.bySource.zelle.cents, false),
      'Other', formatCents(summary.bySource.other.cents + summary.bySource.manual.cents, false)],
    ['Excluded', formatCents(summary.excludedCents, false),
      'Awaiting review', summary.pendingPayments,
      'Duplicates', summary.duplicatePayments,
      'Unmatched payers', summary.unassignedRows],
    [],
  ]

  downloadCsv(
    `${slug(drawing.name)}-master.csv`,
    MASTER_HEADERS,
    rows.map((r) => masterValues(r, summary.totalTickets)),
    preamble,
  )
}

/**
 * Master workbook: the same roll-up plus the full payment ledger and a summary,
 * as three sheets. What you would archive for the quarter.
 */
export async function exportMasterWorkbook(
  drawing: Drawing,
  payments: Payment[],
  entrants: Entrant[],
): Promise<void> {
  const rows = buildMasterRows(payments, entrants)
  const summary = summariseMaster(rows)
  const expected = summary.totalTickets * drawing.ticket_price_cents + summary.unallocatedCents
  const nameById = new Map(entrants.map((e) => [e.id, e.display_name]))

  const text = (v: string | null | undefined) => ({ value: sanitizeForSpreadsheet(v ?? ''), type: String })
  const money = (cents: number, blankWhenZero = false) =>
    blankWhenZero && cents === 0 ? { type: Number } : { value: cents / 100, type: Number, format: '#,##0.00' }
  const count = (n: number, blankWhenZero = false) =>
    blankWhenZero && n === 0 ? { type: Number } : { value: n, type: Number }
  const bold = (value: string) => ({ value, fontWeight: 'bold' as const })

  const summarySheet = [
    [bold(`${drawing.name} — master record`)],
    [text(BRAND.full), text(BRAND.motto)],
    [],
    [bold('Exported'), text(new Date().toISOString())],
    [bold('Ticket price'), money(drawing.ticket_price_cents)],
    [],
    [bold('Entrants with tickets'), count(summary.entrantCount)],
    [bold('Total tickets'), count(summary.totalTickets)],
    [bold('Approved money in'), money(summary.approvedCents)],
    [bold('Tickets x price + unallocated'), money(expected)],
    [bold('Reconciles?'), text(expected === summary.approvedCents ? 'YES' : 'NO — investigate')],
    [],
    [bold('Venmo'), money(summary.bySource.venmo.cents), count(summary.bySource.venmo.payments)],
    [bold('Zelle'), money(summary.bySource.zelle.cents), count(summary.bySource.zelle.payments)],
    [bold('Other / manual'),
      money(summary.bySource.other.cents + summary.bySource.manual.cents),
      count(summary.bySource.other.payments + summary.bySource.manual.payments)],
    [],
    [bold('Excluded'), money(summary.excludedCents), count(summary.excludedPayments)],
    [bold('Unallocated'), money(summary.unallocatedCents)],
    [bold('Awaiting review'), count(summary.pendingPayments)],
    [bold('Duplicates'), count(summary.duplicatePayments)],
    [bold('Unmatched payers'), count(summary.unassignedRows)],
  ]

  const entrantSheet = [
    MASTER_HEADERS.map(bold),
    ...rows.map((r) => {
      const odds = oddsOneIn(r.tickets, summary.totalTickets)
      return [
        text(r.displayName), text(r.displayLabel), text(r.email), text(r.phone),
        count(r.bySource.venmo.payments, true), money(r.bySource.venmo.cents, true),
        count(r.bySource.zelle.payments, true), money(r.bySource.zelle.cents, true),
        count(r.bySource.other.payments + r.bySource.manual.payments, true),
        money(r.bySource.other.cents + r.bySource.manual.cents, true),
        money(r.approvedCents), count(r.tickets),
        odds === null ? { type: Number } : count(odds),
        money(r.unallocatedCents, true),
        count(r.excludedPayments, true), money(r.excludedCents, true),
        count(r.duplicatePayments, true), count(r.pendingPayments, true), count(r.outgoingPayments, true),
        text(r.firstPaidOn), text(r.lastPaidOn), text(r.flags.join(', ')),
        text(r.unassigned ? 'NO — unmatched payer' : 'yes'),
      ]
    }),
  ]

  const paymentSheet = [
    LEDGER_HEADERS.map(bold),
    ...payments.map((p) => [
      count(p.source_row_number ?? 0, true), text(p.paid_on),
      text(p.raw_payer_name ?? p.payer_name), text(p.entrant_id ? nameById.get(p.entrant_id) ?? '' : ''),
      text(p.source), text(p.direction === 'in' ? 'Money in' : 'Money out'),
      money(p.amount_cents), count(p.entries), money(p.remainder_cents, true),
      text(p.status), text(p.flags.join(', ')), text(p.note), text(p.external_ref), text(p.exclude_reason),
    ]),
  ]

  // Multiple sheets go in as one array of {data, sheet, columns} objects.
  // Passing the sheets and their options as two parallel arrays is the v3 API
  // and throws at runtime on v4.
  const blob = await writeXlsxFile(
    [
      {
        data: summarySheet,
        sheet: 'Summary',
        columns: [{ width: 30 }, { width: 22 }, { width: 14 }],
      },
      {
        data: entrantSheet,
        sheet: 'Entrants',
        stickyRowsCount: 1,
        columns: [
          { width: 26 }, { width: 16 }, { width: 24 }, { width: 16 },
          { width: 14 }, { width: 12 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 12 },
          { width: 12 }, { width: 9 }, { width: 11 }, { width: 12 },
          { width: 16 }, { width: 15 }, { width: 11 }, { width: 15 }, { width: 10 },
          { width: 13 }, { width: 13 }, { width: 30 }, { width: 20 },
        ],
      },
      {
        data: paymentSheet,
        sheet: 'Payments',
        stickyRowsCount: 1,
        columns: [
          { width: 7 }, { width: 12 }, { width: 24 }, { width: 22 }, { width: 9 }, { width: 11 },
          { width: 12 }, { width: 9 }, { width: 12 }, { width: 14 }, { width: 34 }, { width: 30 },
          { width: 20 }, { width: 22 },
        ],
      },
    ] as never,
  ).toBlob()

  triggerDownload(blob, `${slug(drawing.name)}-master.xlsx`)
}
