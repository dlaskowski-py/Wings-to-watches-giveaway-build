import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The Edge Function that runs the official draw and the browser page that
 * verifies it must execute identical code. This test is what makes that
 * guarantee real rather than aspirational: if someone edits either copy, the
 * suite fails and tells them how to fix it.
 */
describe('draw core sync', () => {
  it('supabase/functions/drawing-actions/draw-core.ts is a verbatim copy of src/lib/draw/core.ts', () => {
    const root = join(import.meta.dirname, '../../..')
    const source = readFileSync(join(root, 'src/lib/draw/core.ts'), 'utf8')
    const copy = readFileSync(join(root, 'supabase/functions/drawing-actions/draw-core.ts'), 'utf8')

    const body = copy.slice(copy.indexOf('/**'))
    expect(
      body,
      'draw-core.ts has drifted from core.ts. Run: node scripts/sync-draw-core.mjs',
    ).toBe(source)
  })
})
