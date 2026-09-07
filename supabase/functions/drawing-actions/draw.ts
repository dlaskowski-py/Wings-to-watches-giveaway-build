/**
 * execute-draw — reveal, draw, and record the result permanently.
 *
 * Runs once per drawing. It fetches the drand round the operator committed to
 * at lock time, derives the final seed from (frozen entrant list + secret seed
 * + public beacon), selects the winners deterministically, and writes both the
 * winners and the revealed seed so anybody can recompute the whole thing.
 *
 * The three guards that matter:
 *   - the drawing must be `locked`, and the DB trigger makes `drawn` terminal,
 *     so this cannot run twice;
 *   - the committed beacon round must have actually happened, so the operator
 *     cannot draw early against a value they could influence;
 *   - the snapshot is re-hashed and compared to the published commitment before
 *     anything is drawn, so a snapshot edited after locking aborts the draw
 *     instead of quietly producing different winners.
 */
import {
  HttpError,
  errorResponse,
  json,
  requireOperator,
  serviceClient,
  writeAudit,
} from './auth.ts'
import { fetchRound } from './beacon.ts'
import {
  DRAW_PROTOCOL_VERSION,
  executeDraw,
  type DrawSnapshot,
  type SnapshotEntrant,
} from './draw-core.ts'

export async function handleDraw(req: Request): Promise<Response> {
  try {
    const admin = serviceClient()
    const caller = await requireOperator(req, admin)

    const body = await req.json().catch(() => ({}))
    const drawingId = String(body.drawingId ?? '')
    if (!drawingId) throw new HttpError(400, 'drawingId is required')

    const { data: drawing, error: drawingError } = await admin
      .from('drawings')
      .select('*')
      .eq('id', drawingId)
      .maybeSingle()

    if (drawingError) throw new HttpError(500, drawingError.message)
    if (!drawing) throw new HttpError(404, 'Drawing not found')
    if (drawing.status === 'drawn' || drawing.status === 'published') {
      throw new HttpError(409, 'This drawing has already been drawn. Results are permanent.')
    }
    if (drawing.status !== 'locked') {
      throw new HttpError(409, `Lock the drawing before drawing it (status is "${drawing.status}")`)
    }

    // Belt and braces alongside the primary-key constraint on draw_results.
    const { count: existingResults } = await admin
      .from('draw_results')
      .select('rank', { count: 'exact', head: true })
      .eq('drawing_id', drawingId)
    if ((existingResults ?? 0) > 0) {
      throw new HttpError(409, 'Results already exist for this drawing')
    }

    // ---- the beacon must have actually happened ---------------------------
    let beacon
    try {
      beacon = await fetchRound(Number(drawing.beacon_round))
    } catch (err) {
      const expectedAt = drawing.beacon_expected_at ? new Date(drawing.beacon_expected_at) : null
      if (expectedAt && expectedAt.getTime() > Date.now()) {
        const secondsLeft = Math.ceil((expectedAt.getTime() - Date.now()) / 1000)
        throw new HttpError(
          425,
          `Beacon round ${drawing.beacon_round} has not been published yet. ` +
            `It is expected at ${expectedAt.toISOString()} (about ${secondsLeft}s from now). ` +
            'Waiting is the point: nobody can know the outcome until then.',
        )
      }
      throw new HttpError(503, `Could not fetch drand round ${drawing.beacon_round}: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (beacon.chain !== drawing.beacon_chain) {
      throw new HttpError(500, 'drand chain does not match the one committed at lock time')
    }

    // ---- rebuild the frozen snapshot --------------------------------------
    const { data: snapshotRows, error: snapshotError } = await admin
      .from('draw_snapshot_entries')
      .select('public_id, display_label, tickets')
      .eq('drawing_id', drawingId)

    if (snapshotError) throw new HttpError(500, snapshotError.message)
    if (!snapshotRows || snapshotRows.length === 0) {
      throw new HttpError(500, 'The frozen entrant list is missing for this drawing')
    }

    const entrants: SnapshotEntrant[] = snapshotRows.map((r) => ({
      publicId: r.public_id as string,
      displayLabel: r.display_label as string,
      tickets: r.tickets as number,
    }))

    const snapshot: DrawSnapshot = {
      protocolVersion: DRAW_PROTOCOL_VERSION,
      drawingId,
      drawingName: drawing.name,
      ticketPriceCents: drawing.ticket_price_cents,
      winnerCount: drawing.winner_count,
      alternateCount: drawing.alternate_count,
      entrants,
    }

    // ---- secret seed (service role only) ----------------------------------
    const { data: secret, error: secretError } = await admin
      .from('drawing_secrets')
      .select('secret_seed')
      .eq('drawing_id', drawingId)
      .maybeSingle()

    if (secretError) throw new HttpError(500, secretError.message)
    if (!secret) throw new HttpError(500, 'The committed seed is missing for this drawing')

    // ---- draw --------------------------------------------------------------
    const result = await executeDraw(snapshot, secret.secret_seed as string, beacon)

    // The commitment published to the group is the contract. If the frozen list
    // no longer hashes to it, something changed after locking and this draw must
    // not proceed under the old commitment.
    if (result.snapshotHash !== drawing.snapshot_hash) {
      throw new HttpError(
        500,
        'Snapshot hash mismatch: the frozen entrant list no longer matches the commitment published at lock time. ' +
          'Refusing to draw.',
      )
    }
    if (result.seedCommitment !== drawing.seed_commitment) {
      throw new HttpError(500, 'Seed commitment mismatch. Refusing to draw.')
    }

    const resultRows = result.winners.map((w) => ({
      drawing_id: drawingId,
      rank: w.rank,
      public_id: w.publicId,
      display_label: w.displayLabel,
      tickets: w.tickets,
      is_alternate: w.isAlternate,
    }))

    const { error: insertError } = await admin.from('draw_results').insert(resultRows)
    if (insertError) throw new HttpError(500, `Failed to record results: ${insertError.message}`)

    const { error: updateError } = await admin
      .from('drawings')
      .update({
        status: 'drawn',
        beacon_randomness: beacon.randomness,
        final_seed: result.finalSeed,
        revealed_seed: secret.secret_seed,
        random_words_used: result.randomWordsConsumed,
        drawn_at: new Date().toISOString(),
      })
      .eq('id', drawingId)
      .eq('status', 'locked')

    if (updateError) throw new HttpError(500, `Failed to finalise drawing: ${updateError.message}`)

    await writeAudit(admin, drawingId, caller, 'drawing.drawn', {
      beacon_round: beacon.round,
      beacon_randomness: beacon.randomness,
      final_seed: result.finalSeed,
      total_tickets: result.totalTickets,
      total_entrants: result.totalEntrants,
      winners: result.winners.map((w) => ({ rank: w.rank, public_id: w.publicId, tickets: w.tickets })),
    })

    return json({ ok: true, drawingId, ...result })
  } catch (err) {
    return errorResponse(err)
  }
}
