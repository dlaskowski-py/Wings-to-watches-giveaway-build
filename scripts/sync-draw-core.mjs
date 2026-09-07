#!/usr/bin/env node
/**
 * Copy src/lib/draw/core.ts into supabase/functions/drawing-actions/draw-core.ts.
 *
 * The Edge Function that runs the official draw and the browser page that
 * verifies it MUST execute identical code. If they can drift, "anyone can
 * verify this" stops being true — the verifier would be checking a different
 * algorithm than the one that picked the winners.
 *
 * Supabase Edge Functions cannot import from outside their own directory, so
 * the file is copied rather than shared. This script does the copy and
 * core.sync.test.ts fails the build if the two ever differ.
 *
 *   node scripts/sync-draw-core.mjs          # write the copy
 *   node scripts/sync-draw-core.mjs --check  # exit 1 if out of date
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'src/lib/draw/core.ts')
const TARGET = join(root, 'supabase/functions/drawing-actions/draw-core.ts')

const BANNER = `// ============================================================================
// GENERATED FILE - DO NOT EDIT.
//
// Verbatim copy of src/lib/draw/core.ts, produced by scripts/sync-draw-core.mjs.
// Edit the original and re-run the script; core.sync.test.ts fails if these
// two files ever differ.
//
// The copy exists because Supabase Edge Functions cannot import from outside
// their own directory, and it is essential that the draw and its independent
// verification run byte-identical code.
// ============================================================================

`

const source = readFileSync(SOURCE, 'utf8')
const expected = BANNER + source

if (process.argv.includes('--check')) {
  const actual = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : ''
  if (actual !== expected) {
    console.error('draw-core.ts is out of date. Run: node scripts/sync-draw-core.mjs')
    process.exit(1)
  }
  console.log('draw-core.ts is in sync')
  process.exit(0)
}

mkdirSync(dirname(TARGET), { recursive: true })
writeFileSync(TARGET, expected)
console.log(`Wrote ${TARGET} (${expected.length} bytes)`)
