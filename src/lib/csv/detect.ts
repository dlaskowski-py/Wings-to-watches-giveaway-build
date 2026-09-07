/**
 * Automatic layout detection.
 *
 * The operator has no single stable file format to work with. Venmo's statement
 * export puts several junk rows above the real header and a running-balance row
 * at the bottom. Zelle has no export at all — the CSV comes from each member's
 * own bank, so Chase, Bank of America and Wells Fargo all look different, and
 * the payer's name is often buried inside a free-text description rather than
 * sitting in a column of its own.
 *
 * Rather than pretend to know every format, this module makes a good guess and
 * then shows its work: the import wizard displays the detected header row and
 * column roles with a live preview, and the operator confirms or corrects them
 * before anything is written. A confirmed layout is saved as a preset.
 */

import { parseAmountToCents } from './amount'
import { parseDate } from './dates'
import type { ColumnMapping, ColumnRole, PaymentSource } from './types'

export type Grid = string[][]

/* -------------------------------------------------------------------------- *
 * Header row detection
 * -------------------------------------------------------------------------- */

/** Words that show up in header cells across the exports we care about. */
const HEADER_KEYWORDS = [
  'date', 'datetime', 'time', 'posted', 'amount', 'total', 'value', 'debit', 'credit',
  'balance', 'name', 'from', 'to', 'payer', 'payee', 'sender', 'recipient', 'note',
  'memo', 'description', 'details', 'id', 'reference', 'ref', 'transaction', 'status',
  'type', 'category', 'account', 'email', 'phone', 'username', 'handle', 'currency',
]

function looksLikeHeaderCell(cell: string): boolean {
  const s = cell.trim()
  if (s === '' || s.length > 48) return false
  // Data, not a header.
  if (parseAmountToCents(s).ok) return false
  if (parseDate(s).ok) return false
  if (/^\d+$/.test(s)) return false
  return /[A-Za-z]/.test(s)
}

function headerKeywordHits(row: readonly string[]): number {
  let hits = 0
  for (const cell of row) {
    const s = cell.trim().toLowerCase()
    if (s === '') continue
    if (HEADER_KEYWORDS.some((k) => s === k || s.includes(k))) hits += 1
  }
  return hits
}

function modalWidth(rows: Grid): number {
  const counts = new Map<number, number>()
  for (const row of rows) {
    const width = row.filter((c) => c.trim() !== '').length
    counts.set(width, (counts.get(width) ?? 0) + 1)
  }
  let best = 0
  let bestCount = -1
  for (const [width, count] of counts) {
    if (count > bestCount) {
      best = width
      bestCount = count
    }
  }
  return best
}

/**
 * Find the row that is actually the header.
 *
 * Scores each candidate on: how many cells read like header labels, how many
 * match known header vocabulary, and — the decisive signal — whether the rows
 * below it are consistently as wide as it is. Venmo's preamble rows fail that
 * last test, which is what makes them distinguishable from the real header.
 */
export function detectHeaderRow(grid: Grid, maxScan = 30): number {
  if (grid.length === 0) return 0

  let bestIndex = 0
  let bestScore = -Infinity

  const limit = Math.min(maxScan, grid.length)
  for (let i = 0; i < limit; i++) {
    const row = grid[i]!
    const nonEmpty = row.filter((c) => c.trim() !== '')
    if (nonEmpty.length < 2) continue

    let score = 0
    score += headerKeywordHits(row) * 4
    score += nonEmpty.filter((c) => looksLikeHeaderCell(c)).length * 1.5
    // Data-looking cells strongly suggest this is not the header.
    score -= nonEmpty.filter((c) => parseAmountToCents(c).ok || parseDate(c).ok).length * 4

    const below = grid.slice(i + 1, i + 8)
    if (below.length > 0) {
      const width = modalWidth(below)
      if (width === nonEmpty.length) score += 5
      else if (Math.abs(width - nonEmpty.length) <= 1) score += 2
      else score -= 2
      // A header with nothing under it is not a header.
      if (below.every((r) => r.every((c) => c.trim() === ''))) score -= 10
    } else {
      score -= 5
    }

    // Prefer earlier rows when scores tie, so a data row that happens to look
    // header-ish later in the file does not win.
    score -= i * 0.1

    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }

  return bestIndex
}

/* -------------------------------------------------------------------------- *
 * Column role scoring
 * -------------------------------------------------------------------------- */

interface RoleRule {
  role: ColumnRole
  /** Header patterns, best first. */
  header: RegExp[]
  /** Header patterns that positively rule the role out. */
  headerExclude?: RegExp[]
  /** Shape check over sample values; returns 0..1. */
  shape?: (values: readonly string[]) => number
  /**
   * When true, value shape alone can never win this role - the header has to
   * say so. Essential for roles whose "shape" is indistinguishable from other
   * columns: every numeric column looks like a Credit column, and a Balance
   * column looks exactly like one. Without this, Chase's running-balance column
   * was claimed as `credit`, which flipped the file into credit/debit mode and
   * made the balance itself get read as the payment amount ($1,050 -> 42
   * tickets). Venmo's always-empty "Amount (fee)" column did the same thing and
   * caused every real payment row to be rejected.
   */
  requiresHeader?: boolean
}

function rate(values: readonly string[], predicate: (v: string) => boolean): number {
  const filled = values.filter((v) => v != null && v.trim() !== '')
  if (filled.length === 0) return 0
  return filled.filter(predicate).length / filled.length
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const HANDLE_RE = /^@?[A-Za-z0-9._-]{3,30}$/
const NAME_RE = /^[\p{L}][\p{L}'.\- ]{1,60}$/u

const ROLE_RULES: RoleRule[] = [
  {
    role: 'date',
    header: [/^date$/i, /date\s*\/?\s*time/i, /^datetime$/i, /posted|transaction\s*date|completion/i, /date/i],
    shape: (v) => rate(v, (x) => parseDate(x).ok),
  },
  {
    role: 'amount',
    header: [/^amount(\s*\(total\))?$/i, /^amount$/i, /amount\s*\(?total\)?/i, /^total$/i, /^value$/i, /amount/i],
    headerExclude: [/fee|tax|tip|balance|net\s*amount\s*after/i],
    shape: (v) => rate(v, (x) => parseAmountToCents(x).ok),
  },
  {
    role: 'credit',
    header: [/^credit$/i, /credit\s*amount/i, /money\s*in/i, /deposit/i, /^in$/i],
    headerExclude: [/balance|fee|tax|tip/i],
    requiresHeader: true,
    shape: (v) => rate(v, (x) => x.trim() === '' || parseAmountToCents(x).ok),
  },
  {
    role: 'debit',
    header: [/^debit$/i, /debit\s*amount/i, /money\s*out/i, /withdrawal/i, /^out$/i],
    headerExclude: [/balance|fee|tax|tip/i],
    requiresHeader: true,
    shape: (v) => rate(v, (x) => x.trim() === '' || parseAmountToCents(x).ok),
  },
  {
    role: 'payer_email',
    header: [/email/i],
    shape: (v) => rate(v, (x) => EMAIL_RE.test(x.trim())),
  },
  {
    role: 'payer_phone',
    requiresHeader: true,
    header: [/phone|mobile|cell/i],
    shape: (v) => rate(v, (x) => /^[\d\s()+\-.]{7,20}$/.test(x.trim()) && x.replace(/\D/g, '').length >= 10),
  },
  {
    role: 'payer_handle',
    requiresHeader: true,
    header: [/username|handle|venmo\s*id|^user$/i],
    shape: (v) => rate(v, (x) => HANDLE_RE.test(x.trim()) && !EMAIL_RE.test(x.trim())),
  },
  {
    role: 'payer_name',
    header: [/^from$/i, /^payer$/i, /^sender$/i, /sender\s*name/i, /payer\s*name/i, /^name$/i, /counterparty/i, /^from\s*name$/i],
    headerExclude: [/^to$/i, /recipient|payee|email|phone|username/i],
    shape: (v) => rate(v, (x) => NAME_RE.test(x.trim()) && x.trim().includes(' ')),
  },
  {
    role: 'note',
    header: [/^note$/i, /^memo$/i, /^message$/i, /^comment$/i, /note|memo/i],
    shape: () => 0.2,
  },
  {
    role: 'description',
    header: [/^description$/i, /^details$/i, /transaction\s*description/i, /^narrative$/i, /description|details/i],
    // Bank descriptions are long free text that is neither a name nor an amount.
    shape: (v) => rate(v, (x) => x.trim().length > 18 && !parseAmountToCents(x).ok),
  },
  {
    role: 'external_ref',
    requiresHeader: true,
    header: [/^id$/i, /transaction\s*id/i, /^reference$/i, /^ref(erence)?\s*(#|no|number)?$/i, /confirmation/i],
    shape: (v) => rate(v, (x) => /^[A-Za-z0-9._:-]{6,40}$/.test(x.trim()) && !parseDate(x).ok),
  },
  {
    role: 'status',
    requiresHeader: true,
    header: [/^status$/i, /^state$/i],
    shape: (v) => rate(v, (x) => /^(complete[d]?|pending|failed|cancell?ed|issued|settled|posted)$/i.test(x.trim())),
  },
  {
    role: 'type',
    requiresHeader: true,
    header: [/^type$/i, /transaction\s*type/i, /^category$/i],
    shape: (v) => rate(v, (x) => x.trim().length > 0 && x.trim().length < 40),
  },
]

export interface ColumnScore {
  columnIndex: number
  role: ColumnRole
  score: number
}

function headerScoreFor(rule: RoleRule, header: string): number {
  const h = header.trim()
  if (h === '') return 0
  if (rule.headerExclude?.some((re) => re.test(h))) return -2
  for (let i = 0; i < rule.header.length; i++) {
    if (rule.header[i]!.test(h)) {
      // Earlier patterns are more specific, so they score higher.
      return 6 - i * 0.5
    }
  }
  return 0
}

/**
 * Score every (column, role) pair, then assign greedily by descending score so
 * each role takes at most one column and each column serves at most one role.
 *
 * Header text and value shape are weighted together on purpose. Header text
 * alone misreads a column called "Name" that actually holds emails; shape alone
 * cannot tell a payer name from a recipient name, since both are just names.
 */
export function scoreColumns(headers: readonly string[], sampleRows: Grid): ColumnScore[] {
  const columns = headers.length
  const samples: string[][] = []
  for (let c = 0; c < columns; c++) {
    samples.push(sampleRows.map((r) => r[c] ?? '').filter((v) => v != null))
  }

  const scores: ColumnScore[] = []
  for (let c = 0; c < columns; c++) {
    const header = headers[c] ?? ''
    const values = samples[c] ?? []
    for (const rule of ROLE_RULES) {
      const headerScore = headerScoreFor(rule, header)
      // A header-required role is simply unavailable without header evidence,
      // no matter how well the values happen to fit.
      if (rule.requiresHeader && headerScore <= 0) continue
      const shapeScore = rule.shape ? rule.shape(values) * 5 : 0
      const total = headerScore + shapeScore
      if (total > 0) scores.push({ columnIndex: c, role: rule.role, score: total })
    }
  }
  return scores.sort((a, b) => b.score - a.score)
}

export function assignRoles(headers: readonly string[], sampleRows: Grid): Partial<Record<ColumnRole, number>> {
  const scores = scoreColumns(headers, sampleRows)
  const roles: Partial<Record<ColumnRole, number>> = {}
  const usedColumns = new Set<number>()

  for (const { columnIndex, role, score } of scores) {
    if (score < 2) break // below this the guess is noise
    if (roles[role] !== undefined) continue
    if (usedColumns.has(columnIndex)) continue
    roles[role] = columnIndex
    usedColumns.add(columnIndex)
  }
  return roles
}

/* -------------------------------------------------------------------------- *
 * Whole-file detection
 * -------------------------------------------------------------------------- */

function guessSource(headers: readonly string[], grid: Grid): PaymentSource {
  const blob = [...headers, ...grid.slice(0, 40).flat()].join(' ').toLowerCase()
  if (blob.includes('venmo')) return 'venmo'
  if (blob.includes('zelle')) return 'zelle'

  // Fall back to the shape of the header row. Venmo re-brands its export
  // wording from time to time, so matching only on the word "Venmo" is brittle;
  // its column set is far more stable.
  const h = headers.map((x) => x.trim().toLowerCase())
  const has = (...names: string[]) => names.every((n) => h.includes(n))
  if (h.includes('amount (total)') || has('datetime', 'from', 'to')) return 'venmo'

  return 'other'
}

function guessDirectionMode(
  roles: Partial<Record<ColumnRole, number>>,
  headers: readonly string[],
  dataRows: Grid,
): ColumnMapping['directionMode'] {
  if (roles.credit !== undefined || roles.debit !== undefined) return 'credit_debit'
  if (roles.amount !== undefined) {
    const col = roles.amount
    const values = dataRows.map((r) => r[col] ?? '')
    const anyNegative = values.some((v) => {
      const parsed = parseAmountToCents(v)
      return parsed.ok && parsed.value.negative
    })
    if (anyNegative) return 'sign'
    // No negatives anywhere: a type column may still distinguish direction.
    if (roles.type !== undefined || roles.status !== undefined) return 'type_column'
    return 'all_incoming'
  }
  if (headers.length === 0) return 'all_incoming'
  return 'all_incoming'
}

export interface DetectionResult {
  mapping: ColumnMapping
  headers: string[]
  dataRows: Grid
  confidence: number
}

/**
 * Detect everything about a raw grid in one pass: where the header is, what the
 * columns mean, which format it came from, and how to read direction.
 *
 * `confidence` is a rough 0..1 self-assessment shown in the wizard so the
 * operator knows how hard to look. It is deliberately conservative: a missing
 * date or amount column drags it down sharply, because those two are the ones
 * that produce wrong numbers rather than merely missing ones.
 */
export function detectLayout(grid: Grid): DetectionResult {
  const headerRowIndex = detectHeaderRow(grid)
  const headers = (grid[headerRowIndex] ?? []).map((h) => h.trim())
  const dataRows = grid.slice(headerRowIndex + 1).filter((r) => r.some((c) => c.trim() !== ''))
  const sample = dataRows.slice(0, 60)

  const roles = assignRoles(headers, sample)
  const source = guessSource(headers, grid)
  const directionMode = guessDirectionMode(roles, headers, sample)

  let confidence = 0.35
  if (roles.date !== undefined) confidence += 0.25
  if (roles.amount !== undefined || (roles.credit !== undefined || roles.debit !== undefined)) confidence += 0.25
  if (roles.payer_name !== undefined || roles.description !== undefined) confidence += 0.15
  if (roles.external_ref !== undefined) confidence += 0.05
  if (dataRows.length === 0) confidence = 0

  return {
    mapping: {
      headerRowIndex,
      roles,
      dateOrder: 'auto',
      directionMode,
      source,
    },
    headers,
    dataRows,
    confidence: Math.min(1, confidence),
  }
}

/**
 * Stable fingerprint of a file's header row, used to offer the matching saved
 * preset next time the operator uploads the same bank's export.
 */
export function headerSignature(headers: readonly string[]): string {
  return headers
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter((h) => h !== '')
    .sort()
    .join('|')
}
