import Papa from 'papaparse'
import type { Grid } from './detect'

/**
 * Turning an uploaded file into a grid of cells.
 *
 * Everything downstream — layout detection, the column mapper, the preview,
 * reconciliation — works on a Grid of strings and does not care where the
 * grid came from. So each format only has to get that far, and the operator
 * still confirms the columns and ties the totals out before anything is saved.
 *
 * The three formats are NOT equally trustworthy, and the UI says so:
 *
 *   CSV    the bank wrote it. Exact.
 *   Excel  the bank wrote it, or the operator did. Exact cells, but dates and
 *          numbers arrive as typed values rather than text, so they are
 *          converted deliberately rather than stringified by accident.
 *   PDF    nobody wrote it as data. It is a page of positioned glyphs and the
 *          table has to be inferred. Best effort, always to be checked.
 */
export type SourceFileKind = 'csv' | 'excel' | 'pdf'

export interface ReadResult {
  grid: Grid
  kind: SourceFileKind
  /** Shown to the operator above the column mapper. */
  notes: string[]
  /**
   * For a PDF only: how many lines looked like a transaction — a date and an
   * amount on the same line. The importer compares this against the number of
   * payments the preview actually produced, so a line the column inference
   * mangled is reported rather than quietly disappearing.
   */
  likelyTransactionLines?: number
}

/** Files are identified by their first bytes. An extension is just a name. */
async function sniff(file: File): Promise<SourceFileKind> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)

  if (starts(0x25, 0x50, 0x44, 0x46)) return 'pdf' // "%PDF"
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'excel' // a zip: .xlsx / .xlsm
  if (starts(0xd0, 0xcf, 0x11, 0xe0)) return 'excel' // OLE2: the older .xls
  return 'csv'
}

/* -------------------------------------------------------------------------- *
 * Excel
 * -------------------------------------------------------------------------- */

/**
 * A spreadsheet cell is a typed value, not text, and the two traps are dates
 * and money.
 *
 * A date arrives as a Date object. Formatting it back as MM/DD would throw
 * away what the file already knows and hand the parser an ambiguity it then
 * has to flag — so it is written as ISO, which is unambiguous by construction.
 *
 * A number arrives as a float, and 25.1 is really 25.099999999999998. Writing
 * that straight out gives the amount parser a value with excess precision,
 * which it would flag. Money is rounded to the cent it was always meant to be.
 */
export function cellToText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return ''
    if (Number.isInteger(value)) return String(value)
    return String(Math.round(value * 1e6) / 1e6)
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  return String(value)
}

async function readExcel(file: File): Promise<ReadResult> {
  const { default: readXlsxFile } = await import('read-excel-file/browser')

  // Since v9 the default export returns EVERY sheet as { sheet, data }, not a
  // flat array of rows. Treating the result as rows yields one "row" per sheet
  // object and nothing usable below it.
  const sheets = (await readXlsxFile(file)) as unknown as Array<{ sheet: string; data: unknown[][] }>
  if (!Array.isArray(sheets) || sheets.length === 0) {
    throw new Error('That workbook has no sheets.')
  }

  // The first sheet with any content wins. A statement export occasionally
  // leads with an empty cover sheet, and silently reading that would look like
  // an empty file rather than a wrong guess.
  const chosen = sheets.find((s) => (s.data ?? []).some((r) => r.some((c) => cellToText(c) !== '')))
  if (!chosen) throw new Error('Every sheet in that workbook is empty.')

  const grid: Grid = (chosen.data ?? []).map((row) => row.map(cellToText))

  const notes = [`Read the sheet named “${chosen.sheet}”.`]
  if (sheets.length > 1) {
    notes.push(
      `The workbook has ${sheets.length} sheets (${sheets.map((s) => s.sheet).join(', ')}); ` +
        'only that one was read. Split the others into their own file if they hold payments too.',
    )
  }
  return { grid, kind: 'excel', notes }
}

/* -------------------------------------------------------------------------- *
 * PDF
 * -------------------------------------------------------------------------- */

export interface Glyph {
  text: string
  x: number
  /** Right edge. A right-aligned column is only identifiable from this. */
  right: number
  y: number
  height: number
}

/**
 * Group glyphs into lines by their baseline.
 *
 * Tolerance scales with the type size rather than being a fixed number of
 * points, because a statement mixes an 11pt body with 7pt footnotes and a
 * tolerance that suits one splits or merges the other.
 */
export function intoLines(glyphs: Glyph[]): Glyph[][] {
  const sorted = [...glyphs].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Glyph[][] = []
  let current: Glyph[] = []
  let baseline: number | null = null

  for (const g of sorted) {
    const tolerance = Math.max(2, g.height * 0.5)
    if (baseline === null || Math.abs(g.y - baseline) <= tolerance) {
      current.push(g)
      baseline = baseline === null ? g.y : (baseline + g.y) / 2
    } else {
      if (current.length) lines.push(current.sort((a, b) => a.x - b.x))
      current = [g]
      baseline = g.y
    }
  }
  if (current.length) lines.push(current.sort((a, b) => a.x - b.x))
  return lines
}

/**
 * Find the column boundaries.
 *
 * Three approaches were tried against a real statement before this one, and
 * each failed in a way worth recording, because each looks reasonable:
 *
 *  1. Cluster where text STARTS. Money is right-aligned, so "25.00" and
 *     "1,000.00" begin in different places and never cluster. Amount merged
 *     with Running Bal., and the amount parser then read whichever number came
 *     first — the failure that once turned a $1,050 balance into 42 tickets,
 *     avoided here only by luck of column order.
 *  2. Treat a gutter as whitespace NO line crosses. The bank name and account
 *     line run the width of the page and paint over every gutter below them.
 *  3. Tolerate a few crossing lines. Tuning that tolerance moved the breakage
 *     between "Date+Description merged" and "Description+Amount merged"
 *     without ever clearing both.
 *
 * What actually separates a table row from a heading is SHAPE: every row of a
 * table has the same number of pieces in the same places, and a heading is one
 * long run. So the modal piece-count wins the vote, and only lines of that
 * shape get to define the columns. Headings, footers and stray notes are
 * excluded by construction rather than by a threshold, and the gutters that
 * remain are the table's own.
 */
export function columnEdges(lines: Glyph[][]): number[] {
  if (lines.length === 0) return []

  // How many pieces each line is made of, ignoring lines of a single run.
  const counts = new Map<number, number>()
  for (const line of lines) {
    if (line.length < 2) continue
    counts.set(line.length, (counts.get(line.length) ?? 0) + 1)
  }

  let shape = 0
  let best = 0
  for (const [pieces, howMany] of counts) {
    // Ties go to the wider shape: a table with more columns is a better
    // description of the page than the same rows seen as fewer.
    if (howMany > best || (howMany === best && pieces > shape)) {
      best = howMany
      shape = pieces
    }
  }

  // Fall back to every line when no shape repeats enough to be a table.
  const rows = best >= 3 ? lines.filter((l) => l.length === shape) : lines
  const spans = rows.map((line) => line.map((g) => [g.x, g.right] as const))
  const all = spans.flat()
  if (all.length === 0) return []

  const pageLeft = Math.min(...all.map((s) => s[0]))
  const pageRight = Math.max(...all.map((s) => s[1]))
  const minGutter = Math.max(3, (pageRight - pageLeft) * 0.005)

  // Within one shape the rows agree, so a gutter is simply whitespace none of
  // them crosses.
  const covered: Array<[number, number]> = []
  for (const [start, end] of [...all].sort((a, b) => a[0] - b[0])) {
    const last = covered[covered.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else covered.push([start, end])
  }

  const edges = [covered[0]![0]]
  for (let i = 1; i < covered.length; i++) {
    if (covered[i]![0] - covered[i - 1]![1] >= minGutter) edges.push(covered[i]![0])
  }
  return edges
}

export function lineToCells(line: Glyph[], edges: number[]): string[] {
  if (edges.length === 0) return [line.map((g) => g.text).join(' ').trim()]
  const cells = new Array<string>(edges.length).fill('')
  for (const g of line) {
    // The last edge at or left of this glyph is its column.
    let column = 0
    for (let i = 0; i < edges.length; i++) if (g.x >= edges[i]! - 1) column = i
    cells[column] = cells[column] ? `${cells[column]} ${g.text}` : g.text
  }
  return cells.map((c) => c.trim())
}

async function readPdf(file: File): Promise<ReadResult> {
  // Loaded only when a PDF is actually uploaded — it is by far the largest
  // dependency here and most imports are CSV.
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = (
    await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ).default

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const grid: Grid = []

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    const glyphs: Glyph[] = []
    for (const item of content.items) {
      if (!('str' in item) || item.str.trim() === '') continue
      const t = item.transform as number[]
      const x = t[4]!
      const width = typeof item.width === 'number' ? item.width : item.str.length * 4
      glyphs.push({
        text: item.str.trim(),
        x,
        right: x + width,
        y: t[5]!,
        height: Math.abs(t[3]!) || 10,
      })
    }
    const lines = intoLines(glyphs)
    const edges = columnEdges(lines)
    for (const line of lines) grid.push(lineToCells(line, edges))
  }

  if (grid.length === 0) {
    throw new Error(
      'No text could be read from that PDF. If it is a scan or a photo of a ' +
        'statement, the words are pixels rather than text — download the CSV ' +
        'from your bank instead.',
    )
  }

  // Count transaction-looking lines from the RAW text of each line, before
  // any column inference, so this is an independent second opinion rather than
  // a restatement of the same guess.
  const DATE = /\b(\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/
  const MONEY = /(?:^|\s)-?\$?\d{1,3}(?:,\d{3})*\.\d{2}\b/
  const likelyTransactionLines = grid.filter((cells) => {
    const line = cells.join(' ')
    return DATE.test(line) && MONEY.test(line)
  }).length

  return {
    grid,
    kind: 'pdf',
    likelyTransactionLines,
    notes: [
      `Read ${doc.numPages === 1 ? '1 page' : `${doc.numPages} pages`} by position, because a PDF has no columns of its own.`,
      'Check the preview carefully. If your bank offers a CSV download, that is exact and this is not.',
    ],
  }
}

/* -------------------------------------------------------------------------- *
 * Entry point
 * -------------------------------------------------------------------------- */

export async function readTabularFile(file: File): Promise<ReadResult> {
  const kind = await sniff(file)
  if (kind === 'excel') return readExcel(file)
  if (kind === 'pdf') return readPdf(file)

  const text = await file.text()
  if (text.trim() === '') throw new Error('That file is empty.')
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false })
  const grid = (parsed.data ?? []) as Grid
  if (grid.length === 0) throw new Error('Could not read any rows from that file.')
  return { grid, kind: 'csv', notes: [] }
}
