import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Drawing, Entrant, Payment } from './types'

/**
 * write-excel-file is stubbed so these tests assert the SHAPE we hand it. The
 * multi-sheet call previously used the v3 form — sheet data and sheet names as
 * two parallel arrays — which the v4 library rejects at runtime. Nothing caught
 * it because the click handler discards the promise, so the master workbook
 * button silently produced no file at all.
 */
const calls: unknown[][] = []
vi.mock('write-excel-file/browser', () => ({
  default: (...args: unknown[]) => {
    calls.push(args)
    return { toBlob: async () => new Blob(['x']), toFile: async () => {} }
  },
}))

const downloads: string[] = []
URL.createObjectURL = () => 'blob:stub'
URL.revokeObjectURL = () => {}
vi.stubGlobal('document', {
  createElement: () => ({ click: () => {}, set download(n: string) { downloads.push(n) } }),
  body: { appendChild: () => {}, removeChild: () => {} },
})

const { exportMasterWorkbook, exportLedgerXlsx } = await import('./export')

const D = 'd1'
const drawing = { id: D, name: '2026 Q3 Giveaway', ticket_price_cents: 2500 } as Drawing
const entrants = [
  { id: 'e1', drawing_id: D, display_name: 'Daniel Laskowski', display_label: 'Daniel L.',
    public_id: 'p1', primary_email: null, primary_phone: null, notes: null,
    created_at: '', updated_at: '' } as Entrant,
]
const payment = (o: Partial<Payment>): Payment => ({
  id: 'p', drawing_id: D, batch_id: null, entrant_id: 'e1', source: 'venmo',
  raw_payer_name: null, payer_name: null, payer_email: null, payer_phone: null, payer_handle: null,
  paid_at: null, paid_on: '2026-07-15', amount_cents: 2500, direction: 'in', note: null,
  external_ref: null, raw_row: {}, source_row_number: null, entries: 1, entries_override: null,
  override_reason: null, remainder_cents: 0, status: 'approved', exclude_reason: null, flags: [],
  dedupe_hash: 'h', occurrence: 0, created_at: '', updated_at: '', ...o,
} as Payment)

const payments = [
  payment({ id: 'a', source: 'venmo', amount_cents: 5000, entries: 2 }),
  payment({ id: 'b', source: 'zelle', amount_cents: 2500, entries: 1 }),
]

describe('exportMasterWorkbook', () => {
  beforeEach(() => { calls.length = 0; downloads.length = 0 })

  it('passes one array of sheet objects, not parallel arrays', async () => {
    await exportMasterWorkbook(drawing, payments, entrants)

    expect(calls).toHaveLength(1)
    const sheets = calls[0]?.[0] as Array<Record<string, unknown>>
    expect(Array.isArray(sheets)).toBe(true)
    // The v4 library throws on an array whose first element is itself an array
    // of rows; every entry has to be a {data, sheet} object.
    for (const sheet of sheets) {
      expect(Array.isArray(sheet)).toBe(false)
      expect(Array.isArray(sheet.data)).toBe(true)
      expect(typeof sheet.sheet).toBe('string')
    }
    expect(sheets.map((s) => s.sheet)).toEqual(['Summary', 'Entrants', 'Payments'])
    // Sheet names must not be carried in a second options argument.
    expect(calls[0]?.[1]).toBeUndefined()
  })

  it('gives each sheet as many column widths as it has columns', async () => {
    await exportMasterWorkbook(drawing, payments, entrants)
    const sheets = calls[0]?.[0] as Array<{ data: unknown[][]; columns: unknown[] }>
    for (const sheet of sheets.slice(1)) {
      expect(sheet.columns).toHaveLength(sheet.data[0]?.length ?? 0)
    }
  })

  it('merges a person paying through both rails onto one row', async () => {
    await exportMasterWorkbook(drawing, payments, entrants)
    const sheets = calls[0]?.[0] as Array<{ sheet: string; data: Array<Array<{ value?: unknown }>> }>
    const entrantSheet = sheets.find((s) => s.sheet === 'Entrants')
    const body = entrantSheet?.data.slice(1) ?? []
    expect(body).toHaveLength(1)
    expect(body[0]?.[0]?.value).toBe('Daniel Laskowski')
    expect(downloads).toEqual(['2026-q3-giveaway-master.xlsx'])
  })
})

describe('exportLedgerXlsx', () => {
  beforeEach(() => { calls.length = 0; downloads.length = 0 })

  it('uses the single-sheet form with a column schema', async () => {
    await exportLedgerXlsx(drawing, payments.map((p) => ({ payment: p, entrantName: 'Daniel Laskowski' })))
    const [rows, options] = calls[0] as [unknown[], Record<string, unknown>]
    expect(Array.isArray(rows)).toBe(true)
    expect(options.sheet).toBe('Payments')
    expect(Array.isArray(options.columns)).toBe(true)
    expect(downloads).toEqual(['2026-q3-giveaway-payments.xlsx'])
  })
})
