/**
 * Identity normalisation and matching.
 *
 * The same human pays by Venmo as "@dan-laskowski", by Zelle as
 * "DANIEL J LASKOWSKI", and their bank writes it into a description string as
 * "ZELLE FROM DAN LASKOWSKI ON 09/05". All three have to land on one entrant,
 * or that person's odds are split across three ghosts.
 *
 * The rule the operator chose: merge automatically ONLY on an exact normalised
 * identity match (same email, same phone, same handle, same normalised name).
 * Anything fuzzier is offered as a SUGGESTION they approve or reject. Silently
 * merging on a guess would quietly change somebody's odds, and this system
 * exists to stop invisible decisions like that.
 */

export type AliasKind = 'name' | 'email' | 'phone' | 'handle'

export interface Alias {
  kind: AliasKind
  raw: string
  norm: string
}

/** Honorifics and suffixes that add noise to a name comparison. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'rev'])
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'md', 'phd', 'esq', 'dds'])

/**
 * Fold a display name to a comparison key: strip accents, drop punctuation,
 * remove titles and suffixes, lowercase, collapse whitespace.
 */
export function normalizeName(raw: string | null | undefined): string {
  if (!raw) return ''
  const folded = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')            // strip combining accents: Renee === Renee
    // Apostrophes go FIRST and go entirely. If they were merely "allowed", a
    // curly apostrophe would fall through to the punctuation pass and become a
    // space, so "O'Brien" typed with a smart quote would normalise to
    // "o brien" while the straight-quote version stayed "o'brien" - and the
    // same person would end up as two entrants with split odds.
    .replace(/[\u0027\u2018\u2019\u02bc\u0060\u00b4]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')               // any other punctuation -> separator
    .replace(/-/g, ' ')                          // "Mary-Jane" === "Mary Jane"
    .replace(/\s+/g, ' ')
    .trim()

  const tokens = folded
    .split(' ')
    .filter((t) => t.length > 0)
    .filter((t) => !TITLES.has(t))
    .filter((t) => !SUFFIXES.has(t))

  return tokens.join(' ')
}

/**
 * Lowercase and trim. Gmail dot/plus folding is applied only in
 * `emailMatchKey`, never here — we store what the person actually used.
 */
export function normalizeEmail(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''
}

/**
 * Aggressive key for matching only: strips +tags everywhere, and dots in the
 * local part for Gmail (where they are genuinely ignored — doing this for all
 * providers would wrongly merge distinct people).
 */
export function emailMatchKey(raw: string | null | undefined): string {
  const email = normalizeEmail(raw)
  if (!email) return ''
  const atIndex = email.lastIndexOf('@')
  let local = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)
  const plus = local.indexOf('+')
  if (plus !== -1) local = local.slice(0, plus)
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

/**
 * Digits only, with the US country code dropped so "+1 555 123 4567",
 * "(555) 123-4567" and "5551234567" all agree. Anything that is not a
 * plausible phone number returns '' rather than a partial key, because a
 * partial key would match the wrong people.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return ''
  const digits = String(raw).replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1)
  if (digits.length === 10) return digits
  if (digits.length > 11 && digits.length <= 15) return digits // international
  return ''
}

/** Venmo-style handle: strip a leading @, lowercase. */
export function normalizeHandle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim().replace(/^@+/, '').toLowerCase()
  return /^[a-z0-9._-]{2,}$/.test(s) ? s : ''
}

/* ========================================================================== *
 * Extracting a payer name out of a bank description
 *
 * Zelle has no export of its own — the CSV comes from the member's bank, and
 * every bank writes the counterparty into a free-text description differently.
 * These are the shapes seen across Chase, Bank of America, Wells Fargo, Citi
 * and the NACHA-style descriptors credit unions emit.
 *
 * Anything matched here is marked lower-confidence so the operator confirms it
 * in review rather than trusting a regex with someone's entry count.
 * ========================================================================== */

export interface ExtractedPayer {
  name: string
  /** 'from' means money in; 'to' means money out. null when the text does not say. */
  direction: 'from' | 'to' | null
  pattern: string
}

const DESCRIPTION_PATTERNS: Array<{ id: string; re: RegExp; direction: 'from' | 'to' | null }> = [
  // "ORIG CO NAME:ZELLE ... IND NAME:JOHN SMITH" (NACHA descriptor)
  { id: 'nacha_ind_name', re: /IND\s*NAME\s*:\s*([A-Za-z][A-Za-z'. -]{1,60})/i, direction: 'from' },
  // "Zelle payment from JOHN SMITH 22001234567" / "ZELLE FROM JOHN SMITH ON 09/05"
  { id: 'zelle_from', re: /ZELLE[^A-Za-z]{0,20}(?:PAYMENT|TRANSFER|CREDIT|INSTANT\s*PMT)?[^A-Za-z]{0,20}FROM\s+([A-Za-z][A-Za-z'. -]{1,60}?)(?=\s+(?:ON|REF|CONF|CONFIRMATION|#|\d{4,})|$)/i, direction: 'from' },
  // "Zelle payment to JANE DOE"
  { id: 'zelle_to', re: /ZELLE[^A-Za-z]{0,20}(?:PAYMENT|TRANSFER|DEBIT)?[^A-Za-z]{0,20}TO\s+([A-Za-z][A-Za-z'. -]{1,60}?)(?=\s+(?:ON|REF|CONF|CONFIRMATION|#|\d{4,})|$)/i, direction: 'to' },
  // "RECEIVED FROM JOHN SMITH"
  { id: 'received_from', re: /RECEIVED\s+FROM\s+([A-Za-z][A-Za-z'. -]{1,60}?)(?=\s+(?:ON|REF|CONF|#|\d{4,})|$)/i, direction: 'from' },
  // Generic "FROM JOHN SMITH" as a last resort.
  { id: 'generic_from', re: /\bFROM\s+([A-Za-z][A-Za-z'. -]{1,60}?)(?=\s+(?:ON|REF|CONF|#|\d{4,})|$)/i, direction: 'from' },
]

/** Trailing noise banks append after the name. */
function cleanExtractedName(raw: string): string {
  return raw
    .replace(/\b(?:ON|REF|REFERENCE|CONF|CONFIRMATION|ID|TRN|TRACE)\b.*$/i, '')
    .replace(/[#*]+.*$/, '')
    .replace(/\s*\d[\d\s-]*$/, '') // trailing reference digits
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractPayerFromDescription(description: string | null | undefined): ExtractedPayer | null {
  if (!description) return null
  const text = String(description).replace(/\s+/g, ' ').trim()
  if (text === '') return null

  for (const { id, re, direction } of DESCRIPTION_PATTERNS) {
    const m = re.exec(text)
    if (!m?.[1]) continue
    const name = cleanExtractedName(m[1])
    // Require at least two letters and reject all-digit junk.
    if (name.replace(/[^A-Za-z]/g, '').length < 2) continue
    return { name, direction, pattern: id }
  }
  return null
}

/* ========================================================================== *
 * Similarity, for merge SUGGESTIONS only
 * ========================================================================== */

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  let curr = new Array<number>(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]!
}

export function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - levenshtein(a, b) / longest
}

export interface NameMatch {
  score: number
  reason: string
}

/**
 * Score how likely two names belong to the same person.
 *
 * Returns 1.0 only for an exact normalised match — the sole score the importer
 * acts on without asking. Everything else is a suggestion for the merge queue,
 * and the `reason` string is shown verbatim to the operator so they can judge
 * it rather than trusting a bare number.
 */
export function compareNames(rawA: string, rawB: string): NameMatch {
  const a = normalizeName(rawA)
  const b = normalizeName(rawB)

  if (a === '' || b === '') return { score: 0, reason: 'one name is empty' }
  if (a === b) return { score: 1, reason: 'exact match after normalization' }

  const ta = a.split(' ')
  const tb = b.split(' ')
  const lastA = ta[ta.length - 1]!
  const lastB = tb[tb.length - 1]!
  const firstA = ta[0]!
  const firstB = tb[0]!

  // Same surname is the strongest signal in a group where people know each other.
  if (lastA === lastB && ta.length > 1 && tb.length > 1) {
    if (firstA === firstB) {
      return { score: 0.95, reason: `same first and last name ("${firstA} ${lastA}"), differing middle name` }
    }
    // "dan" vs "daniel", or an initial "d" vs "daniel".
    const shorter = firstA.length <= firstB.length ? firstA : firstB
    const longer = firstA.length <= firstB.length ? firstB : firstA
    if (longer.startsWith(shorter)) {
      return {
        score: shorter.length === 1 ? 0.8 : 0.9,
        reason: `same surname "${lastA}"; "${shorter}" is a ${shorter.length === 1 ? 'initial' : 'short form'} of "${longer}"`,
      }
    }
    const firstRatio = levenshteinRatio(firstA, firstB)
    if (firstRatio >= 0.75) {
      return { score: 0.78, reason: `same surname "${lastA}"; first names are similar ("${firstA}" / "${firstB}")` }
    }
    return { score: 0.55, reason: `same surname "${lastA}" but different first names` }
  }

  // Reversed order: "Laskowski Daniel" vs "Daniel Laskowski".
  if (ta.length === tb.length && ta.length > 1 && [...ta].sort().join(' ') === [...tb].sort().join(' ')) {
    return { score: 0.9, reason: 'same name tokens in a different order' }
  }

  // Whole-string typo distance, e.g. "jonathan smith" / "jonathon smith".
  const ratio = levenshteinRatio(a, b)
  if (ratio >= 0.87) return { score: Math.min(0.85, ratio), reason: `names differ by a few characters (${(ratio * 100).toFixed(0)}% similar)` }

  return { score: ratio < 0 ? 0 : ratio * 0.5, reason: 'names are not similar' }
}

/** Threshold at which a pair is worth putting in front of the operator. */
export const MERGE_SUGGESTION_THRESHOLD = 0.75

/**
 * Build the alias set for one payment row. These become entrant_aliases rows,
 * and the unique constraint on (drawing, kind, value_norm) is what makes a
 * repeat payment from the same identity land on the same entrant.
 */
export function buildAliases(input: {
  name?: string | null
  email?: string | null
  phone?: string | null
  handle?: string | null
}): Alias[] {
  const aliases: Alias[] = []
  const name = normalizeName(input.name)
  if (name) aliases.push({ kind: 'name', raw: String(input.name), norm: name })
  const email = emailMatchKey(input.email)
  if (email) aliases.push({ kind: 'email', raw: String(input.email), norm: email })
  const phone = normalizePhone(input.phone)
  if (phone) aliases.push({ kind: 'phone', raw: String(input.phone), norm: phone })
  const handle = normalizeHandle(input.handle)
  if (handle) aliases.push({ kind: 'handle', raw: String(input.handle), norm: handle })
  return aliases
}

/**
 * "Daniel Laskowski" -> "Daniel L." for the public snapshot: enough for a member
 * to recognise their own row, not enough to publish a directory of the group.
 */
export function toDisplayLabel(displayName: string): string {
  const cleaned = displayName.replace(/\s+/g, ' ').trim()
  if (cleaned === '') return 'Unknown'
  const parts = cleaned.split(' ').filter(Boolean)
  if (parts.length === 1) return parts[0]!
  const first = parts[0]!
  const lastInitial = parts[parts.length - 1]![0]!.toUpperCase()
  return `${first} ${lastInitial}.`
}
