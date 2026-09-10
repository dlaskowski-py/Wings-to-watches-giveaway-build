#!/usr/bin/env node
/**
 * Measures every brand token against the grounds it is actually used on.
 *
 * The ADJL Technology kit states a ratio next to every value and says the site
 * fails its build if they drift. That claim is only worth anything if something
 * checks it, so this does. It parses the real @theme block in src/index.css —
 * not a copy of the numbers — so the check cannot silently agree with a stale
 * table.
 *
 * WCAG 2.1: 4.5:1 normal text, 3:1 large text (>=24px, or >=18.7px bold) and
 * UI boundaries.
 */
import { readFileSync } from 'node:fs'

const CSS = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

/** Pull `--color-x-y: #hex` pairs out of the @theme block. */
function readTokens() {
  const block = CSS.match(/@theme\s*\{([\s\S]*?)\n\}/)
  if (!block) throw new Error('no @theme block found in src/index.css')
  const out = new Map()
  for (const m of block[1].matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out.set(m[1], m[2].toLowerCase())
  }
  if (out.size === 0) throw new Error('@theme block parsed but held no --color-* tokens')
  return out
}

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgb(v / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

const T = readTokens()
const hex = (name) => {
  const v = T.get(name)
  if (!v) throw new Error(`token --color-${name} is missing from src/index.css`)
  return v
}

/*
 * The wheel's own palette is NOT checked here: WHEEL_COLORS lives in
 * src/lib/wheel.ts and labelColorOn picks a label per fill at runtime. That
 * pairing is guarded by src/lib/wheel.test.ts, which imports the real array
 * rather than a copy of it.
 */

/**
 * Each row is a pairing the app actually renders. `min` is the bar that pairing
 * has to clear: 4.5 for body text, 3 for large text and UI boundaries.
 */
const PAGE = 'ink-50'
const SURFACE = 'white'
const HEXES = { white: '#ffffff' }
const resolve = (n) => HEXES[n] ?? hex(n)

const CHECKS = [
  // — Text on the page ground and on cards ————————————————————
  ['ink-900', PAGE, 4.5, 'headings and primary text'],
  ['ink-900', SURFACE, 4.5, 'headings on a card'],
  ['ink-800', PAGE, 4.5, 'strong body text'],
  ['ink-700', PAGE, 4.5, 'body text'],
  ['ink-600', PAGE, 4.5, 'secondary body text'],
  ['ink-500', PAGE, 4.5, 'labels, captions, metadata — the readability tier'],
  ['ink-500', SURFACE, 4.5, 'labels on a card'],
  ['ink-400', PAGE, 4.5, 'faint text; still has to be readable'],
  ['ink-400', SURFACE, 4.5, 'faint text on a card'],
  ['ink-300', PAGE, 3, 'decorative and large-only'],

  // — Copper ————————————————————————————————————————————————
  ['brand-600', PAGE, 4.5, 'body links'],
  ['brand-600', SURFACE, 4.5, 'body links on a card'],
  ['brand-700', PAGE, 4.5, 'link hover'],
  ['brand-800', PAGE, 4.5, 'deep copper text'],
  ['brand-900', PAGE, 4.5, 'deepest copper text'],
  ['brand-500', PAGE, 3, 'rules, focus rings, art — never small text'],

  // — Teal: the only spectrum colour in use ————————————————————
  // teal-400 is not measured against the page ground on purpose. The kit lists
  // --teal #0FA3A3 at 3.0:1 and it is actually 2.97:1 on #FAFAFC, but the value
  // never touches the page: it is a wheel wedge fill, sitting against other
  // wedges and white hairlines. What has to hold there is the label drawn on
  // top of it, and src/lib/wheel.test.ts measures exactly that.
  ['teal-600', PAGE, 4.5, 'teal words'],
  ['teal-800', 'teal-50', 4.5, 'status badge text on its own tint'],
  ['teal-200', SURFACE, 1.25, 'status badge ring must read as an edge'],

  // — Semantic text ——————————————————————————————————————————
  ['good-600', PAGE, 4.5, 'positive text'],
  ['good-700', SURFACE, 4.5, 'positive text on a tint'],
  ['good-800', 'good-50', 4.5, 'positive text on its own tint'],
  ['good-900', 'good-50', 4.5, 'positive heading on its own tint'],
  ['warn-600', PAGE, 3, "the kit's --warn value; icons and UI, not body text"],
  ['warn-700', PAGE, 4.5, 'caution text'],
  ['warn-800', 'warn-50', 4.5, 'caution text on its own tint'],
  ['bad-600', PAGE, 4.5, 'failure text'],
  ['bad-700', PAGE, 4.5, 'failure text, strong'],
  ['bad-800', 'bad-50', 4.5, 'failure text on its own tint'],

  // — White on solid fills. A button's label is text. ————————————
  ['white', 'brand-600', 4.5, 'white label on the primary button'],
  ['white', 'brand-700', 4.5, 'white label on the primary button, hover'],
  ['white', 'bad-600', 4.5, 'white label on the destructive button'],
  ['white', 'bad-700', 4.5, 'white label on the destructive button, hover'],

  // — Boundaries ——————————————————————————————————————————————
  // Not a WCAG bar. A hairline below about 1.25:1 on this ground stops
  // reading as an edge, which is a legibility floor of our own.
  ['ink-200', PAGE, 1.25, 'card and table hairlines must read as an edge'],
  ['brand-500', SURFACE, 3, 'focus ring against a card'],
]


/*
 * The tinted grounds. Faint text ends up inside callouts, status chips and
 * highlighted rows, and those are darker than the page — measuring a faint
 * tier only against the page ground and white is measuring it against its two
 * friendliest cases.
 */
const TINTS = ['good-50', 'warn-50', 'bad-50', 'brand-50', 'teal-50', 'ink-100', 'ink-150']
for (const tint of TINTS) {
  // ink-150 is --paper-4, the kit's deepest ground and its inset-surface
  // value. The faintest text tier is deliberately not paired with it: at
  // 4.44:1 it would need deepening to the point of being ink-500 anyway, so
  // inset surfaces carry ink-500 and above instead.
  const tiers =
    tint === 'ink-150'
      ? ['ink-900', 'ink-700', 'ink-600', 'ink-500']
      : ['ink-900', 'ink-700', 'ink-600', 'ink-500', 'ink-400']
  for (const fg of tiers) {
    CHECKS.push([fg, tint, 4.5, `body text on the ${tint} tint`])
  }
}

/*
 * ink-300 is exempt on purpose rather than by omission. It is the kit's
 * --ink-faint and the app spends it on three things only: the separator dot
 * between two labels, the text of a disabled button, and one aria-hidden
 * upload icon. WCAG 1.4.3 exempts inactive controls and purely decorative
 * text, so holding it to 4.5:1 would be inventing a rule; asserting a 3:1 bar
 * it happens to miss on the darker tints (2.93:1 on bad-50) would be worse,
 * because the fix would be to darken a token nothing reads. It is measured
 * against the page ground below, which is the claim the kit actually makes
 * about it. If it ever carries real copy, that usage is the bug.
 */

let failed = 0
const rows = []
for (const [fg, bg, min, why] of CHECKS) {
  const r = ratio(resolve(fg), resolve(bg))
  const ok = r >= min
  if (!ok) failed++
  rows.push({ ok, fg, bg, r, min, why })
}

const w = Math.max(...rows.map((x) => `${x.fg} on ${x.bg}`.length))
for (const x of rows) {
  const pair = `${x.fg} on ${x.bg}`.padEnd(w)
  const num = `${x.r.toFixed(2)}:1`.padStart(7)
  console.log(`  ${x.ok ? 'ok  ' : 'FAIL'} ${pair} ${num}  (needs ${x.min})  ${x.why}`)
}

if (failed) {
  console.error(`\ncontrast: ${failed} of ${rows.length} pairings below their bar`)
  process.exit(1)
}
console.log(`\ncontrast: ${rows.length} pairings measured, all clear`)
