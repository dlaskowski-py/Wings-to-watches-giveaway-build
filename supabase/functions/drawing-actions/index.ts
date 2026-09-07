/**
 * drawing-actions — the two privileged operations behind the drawing.
 *
 * Both live in one function because they share the draw core, and it is
 * essential that the code which RUNS the draw is byte-identical to the code a
 * group member runs to VERIFY it (see draw-core.ts). Shipping one copy makes
 * that easy to guarantee.
 *
 *   POST { action: "lock",  drawingId, beaconLeadSeconds? }
 *   POST { action: "draw",  drawingId }
 *
 * Both require a signed-in caller whose email is on the operator allowlist.
 * They run with the service role because the secret seed must be written and
 * read where even the signed-in operator cannot reach it.
 */
import { corsHeaders, errorResponse, json, HttpError } from './auth.ts'
import { handleLock } from './lock.ts'
import { handleDraw } from './draw.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    // The body is read once here and handed to the handler, since a Request
    // body can only be consumed a single time.
    const raw = await req.text()
    let body: Record<string, unknown>
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      throw new HttpError(400, 'Request body must be JSON')
    }

    const action = String(body.action ?? '')
    const rebuilt = () =>
      new Request(req.url, { method: 'POST', headers: req.headers, body: raw })

    switch (action) {
      case 'lock':
        return await handleLock(rebuilt())
      case 'draw':
        return await handleDraw(rebuilt())
      default:
        throw new HttpError(400, `Unknown action "${action}". Expected "lock" or "draw".`)
    }
  } catch (err) {
    return errorResponse(err)
  }
})
