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

export function downloadCsv(fileName: string, headers: string[], rows: unknown[][]): void {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))]
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
