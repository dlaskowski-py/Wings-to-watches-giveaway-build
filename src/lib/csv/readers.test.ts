import { describe, expect, it } from 'vitest'
import { cellToText, columnEdges, intoLines, lineToCells, type Glyph } from './readers'

/** A glyph run: text starting at x, that many points wide, on baseline y. */
const g = (text: string, x: number, width: number, y: number): Glyph => ({
  text, x, right: x + width, y, height: 10,
})

describe('spreadsheet cells', () => {
  it('writes a date as ISO so the parser is never asked to guess the order', () => {
    // A workbook already knows which number is the month. Rendering it back as
    // MM/DD would throw that away and earn an ambiguous_date_order flag.
    expect(cellToText(new Date(2026, 6, 5))).toBe('2026-07-05')
  })

  it('rounds away binary float noise in money', () => {
    expect(cellToText(60.1)).toBe('60.1')
    expect(cellToText(0.1 + 0.2)).toBe('0.3')
    expect(cellToText(25)).toBe('25')
  })

  it('renders empties as empty rather than as the words null or undefined', () => {
    expect(cellToText(null)).toBe('')
    expect(cellToText(undefined)).toBe('')
    expect(cellToText(Number.NaN)).toBe('')
  })
})

describe('PDF line grouping', () => {
  it('groups by baseline and orders each line left to right', () => {
    const lines = intoLines([
      g('Amount', 470, 34, 700),
      g('Date', 33, 20, 700),
      g('07/02', 33, 40, 680),
      g('25.00', 480, 25, 680),
    ])
    expect(lines.map((l) => l.map((x) => x.text))).toEqual([
      ['Date', 'Amount'],
      ['07/02', '25.00'],
    ])
  })
})

describe('PDF column detection', () => {
  /** A statement: four columns, with money right-aligned so widths differ. */
  const statement = (): Glyph[][] => [
    [g('Date', 33, 20, 700), g('Description', 97, 50, 700), g('Amount', 474, 34, 700), g('Running Bal.', 523, 55, 700)],
    [g('07/02/2026', 33, 50, 680), g('Zelle payment from JOHN SMITH', 97, 231, 680), g('25.00', 483, 25, 680), g('2,475.18', 540, 39, 680)],
    [g('07/05/2026', 33, 50, 660), g('Zelle payment from MARIA GARCIA', 97, 300, 660), g('50.00', 483, 25, 660), g('2,525.18', 540, 39, 660)],
    [g('09/15/2026', 33, 50, 640), g('Zelle payment from SARAH JOHNSON', 97, 250, 640), g('1,000.00', 469, 39, 640), g('3,414.76', 540, 39, 640)],
  ]

  it('separates two right-aligned money columns', () => {
    // The whole point. "25.00" and "1,000.00" START in different places, so
    // anything clustering on left edges merges Amount into Running Bal. and the
    // amount parser then reads a balance as a payment.
    const edges = columnEdges(statement())
    expect(edges).toHaveLength(4)

    const row = statement()[3]!
    expect(lineToCells(row, edges)).toEqual([
      '09/15/2026',
      'Zelle payment from SARAH JOHNSON',
      '1,000.00',
      '3,414.76',
    ])
  })

  it('is not defeated by a heading that runs the width of the page', () => {
    // A bank name and an account line paint across every gutter beneath them.
    const withTitles = [
      [g('Bank of America — Adv Plus Banking', 30, 250, 760)],
      [g('Account 1234 5678 9012 · Statement period July 1 2026', 30, 322, 740)],
      ...statement(),
    ]
    const edges = columnEdges(withTitles)
    expect(edges).toHaveLength(4)
    expect(lineToCells(withTitles[3]!, edges)[2]).toBe('25.00')
  })

  it('falls back to one column when the page is not a table at all', () => {
    const prose = [
      [g('This is a letter about your account.', 30, 300, 700)],
      [g('It has no columns whatsoever.', 30, 250, 680)],
    ]
    expect(columnEdges(prose).length).toBeLessThanOrEqual(2)
  })
})
