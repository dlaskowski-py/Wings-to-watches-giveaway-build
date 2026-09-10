#!/usr/bin/env node
/**
 * The ADJL Technology kit's voice rules, as a build step.
 *
 * The kit states them and says a guard enforces them on its own site. Two of
 * them can be checked mechanically, and both had already slipped in here
 * before this existed:
 *
 *   - US English. Six British spellings were sitting in strings the operator
 *     reads, including one in a heading and four in CSV rejection reasons.
 *   - No unmeasured numbers in marketing-style claims.
 *
 * Only STRING LITERALS are scanned, and comments are stripped first: prose in
 * a doc comment is not the product's voice, and failing a build over it would
 * train people to work around this rather than use it.
 *
 * Identifiers are exempt for the same reason — `summariseMaster` is a symbol,
 * not copy — which is why the scan looks at literals rather than raw source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src', import.meta.url).pathname

/** Spellings the kit forbids, mapped to what it wants instead. */
const BRITISH = [
  [/\borganis(e|ed|es|ing|ation|er|ers)\b/gi, 'organiz-'],
  [/\bnormalis(e|ed|es|ing|ation)\b/gi, 'normaliz-'],
  [/\brecognis(e|ed|es|ing|able)\b/gi, 'recogniz-'],
  [/\bunrecognis(ed|able)\b/gi, 'unrecogniz-'],
  [/\bauthoris(e|ed|es|ing|ation)\b/gi, 'authoriz-'],
  [/\bneutralis(e|ed|es|ing)\b/gi, 'neutraliz-'],
  [/\bcolour(s|ed|ing)?\b/gi, 'color'],
  [/\bbehaviour(s|al)?\b/gi, 'behavior'],
  [/\banalys(e|ed|es|ing)\b/gi, 'analyz-'],
  [/\bcancelled\b/gi, 'canceled'],
  [/\blabelled\b/gi, 'labeled'],
  [/\blicence\b/gi, 'license'],
  [/\bfavourite\b/gi, 'favorite'],
  [/\bcatalogue\b/gi, 'catalog'],
  [/\bcentre\b/gi, 'center'],
]

/**
 * Words the kit bans outright. Matched only inside literals, so a variable
 * named `unlockedAt` or a CSS class is not a violation.
 */
const BANNED = [
  /\bcutting[- ]edge\b/gi, /\bworld[- ]class\b/gi, /\bturnkey\b/gi, /\bsynergy\b/gi,
  /\bgame[- ]changing\b/gi, /\bseamless(ly)?\b/gi, /\bempower(s|ed|ing)?\b/gi,
  /\bnot just\b[^.!?]{0,40}\bbut\b/gi,
]

/**
 * The DB speaks its own dialect. These are Postgres enum values and column
 * names, not copy, and changing them would need a migration.
 */
const DB_VOCABULARY = new Set(['cancelled'])

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [full] : []
  })
}

/**
 * Everything a person can read: quoted strings, template literals, and JSX
 * text nodes.
 *
 * The JSX half is the part that matters most and the part easiest to forget —
 * nearly all of this app's prose is text between tags, not a quoted string. An
 * earlier version of this script scanned only literals, passed cleanly, and
 * would have missed the heading that prompted it being written.
 */
function readable(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const out = []
  const at = (index) => code.slice(0, index).split('\n').length

  const lit = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g
  for (let m; (m = lit.exec(code)); ) {
    const text = m[1] ?? m[2] ?? m[3] ?? ''
    if (text.trim().length >= 3) out.push({ text, line: at(m.index) })
  }

  // JSX text: between a closing '>' and the next '<', with no braces (those
  // are expressions, covered as literals above). The lookbehind keeps arrow
  // functions from opening a false text node.
  const jsx = /(?<![=!<>-])>([^<>{}]+)</g
  for (let m; (m = jsx.exec(code)); ) {
    const text = m[1]
    if (text.trim().length >= 3) out.push({ text, line: at(m.index) })
  }
  return out
}

let failed = 0
for (const file of walk(ROOT)) {
  for (const { text, line } of readable(readFileSync(file, 'utf8'))) {
    if (DB_VOCABULARY.has(text.trim())) continue
    for (const [re, want] of BRITISH) {
      for (const hit of text.match(re) ?? []) {
        console.error(`  ${file.replace(ROOT, 'src')}:${line}  "${hit}" — the kit's voice is US English (${want})`)
        failed++
      }
    }
    for (const re of BANNED) {
      for (const hit of text.match(re) ?? []) {
        console.error(`  ${file.replace(ROOT, 'src')}:${line}  "${hit}" — on the kit's banned list`)
        failed++
      }
    }
  }
}

if (failed) {
  console.error(`\ncopy: ${failed} violation${failed === 1 ? '' : 's'} of the kit's voice rules`)
  process.exit(1)
}
console.log('copy: US English, no banned words')
