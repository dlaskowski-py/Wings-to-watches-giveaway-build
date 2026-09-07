/**
 * lock-drawing — freeze the entrant list and publish the commitment.
 *
 * This is the moment the drawing becomes tamper-evident. It:
 *   1. refuses to proceed while any payment is still unreviewed,
 *   2. freezes the approved entrants and their ticket counts,
 *   3. hashes that list with the canonical serializer,
 *   4. generates a secret seed the operator can never read, and commits to it,
 *   5. commits to a drand round that has not happened yet.
 *
 * The operator then publishes those three values to the group. Because the
 * beacon round is in the future, nobody — the operator included — can know the
 * outcome at the moment of commitment. See draw-core.ts for the full argument.
 *
 * Everything runs with the service role because the seed must be written where
 * even the signed-in operator cannot read it back.
 */
import {
  HttpError,
  errorResponse,
  json,
  requireOperator,
  serviceClient,
  writeAudit,
} from './auth.ts'
import { chooseFutureRound } from './beacon.ts'
import {
  DRAW_PROTOCOL_VERSION,
  canonicalizeSnapshot,
  computeSeedCommitment,
  generateSecretSeed,
  hashSnapshot,
  type DrawSnapshot,
  type SnapshotEntrant,
} from './draw-core.ts'

/** Default lead time before the committed beacon round lands. */
const DEFAULT_LEAD_SECONDS = 3600
const MIN_LEAD_SECONDS = 300
const MAX_LEAD_SECONDS = 7 * 24 * 3600

export async function handleLock(req: Request): Promise<Response> {
  try {
    const admin = serviceClient()
    const caller = await requireOperator(req, admin)

    const body = await req.json().catch(() => ({}))
    const drawingId = String(body.drawingId ?? '')
    if (!drawingId) throw new HttpError(400, 'drawingId is required')

    const leadSeconds = Math.min(
      MAX_LEAD_SECONDS,
      Math.max(MIN_LEAD_SECONDS, Number(body.beaconLeadSeconds ?? DEFAULT_LEAD_SECONDS)),
    )

    // ---- load and validate the drawing ------------------------------------
    const { data: drawing, error: drawingError } = await admin
      .from('drawings')
      .select('*')
      .eq('id', drawingId)
      .maybeSingle()

    if (drawingError) throw new HttpError(500, drawingError.message)
    if (!drawing) throw new HttpError(404, 'Drawing not found')
    if (drawing.status !== 'reviewing') {
      throw new HttpError(409, `Only a drawing in review can be locked (this one is "${drawing.status}")`)
    }

    // ---- the review gate ---------------------------------------------------
    // "Let me verify the entire excel before pushing it" is the whole point of
    // this product, so locking is refused while anything is still unreviewed.
    const { count: pendingCount, error: pendingError } = await admin
      .from('payments')
      .select('id', { count: 'exact', head: true })
      .eq('drawing_id', drawingId)
      .eq('status', 'needs_review')

    if (pendingError) throw new HttpError(500, pendingError.message)
    if ((pendingCount ?? 0) > 0) {
      throw new HttpError(
        409,
        `${pendingCount} payment(s) still need review. Approve or exclude every row before locking.`,
      )
    }

    // ---- build the frozen entrant list -------------------------------------
    const { data: payments, error: paymentsError } = await admin
      .from('payments')
      .select('entrant_id, entries')
      .eq('drawing_id', drawingId)
      .eq('status', 'approved')
      .eq('direction', 'in')

    if (paymentsError) throw new HttpError(500, paymentsError.message)

    const ticketsByEntrant = new Map<string, number>()
    let unassigned = 0
    for (const p of payments ?? []) {
      if (!p.entrant_id) {
        if ((p.entries ?? 0) > 0) unassigned += 1
        continue
      }
      ticketsByEntrant.set(p.entrant_id, (ticketsByEntrant.get(p.entrant_id) ?? 0) + (p.entries ?? 0))
    }

    if (unassigned > 0) {
      throw new HttpError(
        409,
        `${unassigned} approved payment(s) earn tickets but are not linked to an entrant. Assign them before locking.`,
      )
    }

    const entrantIds = [...ticketsByEntrant.keys()].filter((id) => (ticketsByEntrant.get(id) ?? 0) > 0)
    if (entrantIds.length === 0) {
      throw new HttpError(409, 'No approved payments earn any tickets, so there is nobody to draw from.')
    }

    const { data: entrants, error: entrantsError } = await admin
      .from('entrants')
      .select('id, public_id, display_label')
      .eq('drawing_id', drawingId)
      .in('id', entrantIds)

    if (entrantsError) throw new HttpError(500, entrantsError.message)
    if ((entrants?.length ?? 0) !== entrantIds.length) {
      throw new HttpError(500, 'Entrant lookup returned an unexpected number of rows')
    }

    const snapshotEntrants: SnapshotEntrant[] = (entrants ?? []).map((e) => ({
      publicId: e.public_id as string,
      displayLabel: e.display_label as string,
      tickets: ticketsByEntrant.get(e.id as string) ?? 0,
    }))

    const snapshot: DrawSnapshot = {
      protocolVersion: DRAW_PROTOCOL_VERSION,
      drawingId,
      drawingName: drawing.name,
      ticketPriceCents: drawing.ticket_price_cents,
      winnerCount: drawing.winner_count,
      alternateCount: drawing.alternate_count,
      entrants: snapshotEntrants,
    }

    // Throws on any malformed entrant, so a bad snapshot can never be written.
    canonicalizeSnapshot(snapshot)
    const snapshotHash = await hashSnapshot(snapshot)

    // ---- commit ------------------------------------------------------------
    const secretSeed = generateSecretSeed()
    const seedCommitment = await computeSeedCommitment(secretSeed)
    const beacon = await chooseFutureRound(leadSeconds)

    const entrantRows = (entrants ?? []).map((e) => ({
      drawing_id: drawingId,
      public_id: e.public_id,
      display_label: e.display_label,
      tickets: ticketsByEntrant.get(e.id as string) ?? 0,
      entrant_id: e.id,
    }))

    const { error: snapshotInsertError } = await admin.from('draw_snapshot_entries').insert(entrantRows)
    if (snapshotInsertError) throw new HttpError(500, `Failed to write snapshot: ${snapshotInsertError.message}`)

    const { error: secretError } = await admin
      .from('drawing_secrets')
      .insert({ drawing_id: drawingId, secret_seed: secretSeed })
    if (secretError) {
      await admin.from('draw_snapshot_entries').delete().eq('drawing_id', drawingId)
      throw new HttpError(500, `Failed to store seed: ${secretError.message}`)
    }

    const { error: updateError } = await admin
      .from('drawings')
      .update({
        status: 'locked',
        snapshot_hash: snapshotHash,
        seed_commitment: seedCommitment,
        beacon_chain: beacon.info.chainHash,
        beacon_round: beacon.round,
        beacon_expected_at: beacon.expectedAt.toISOString(),
        locked_at: new Date().toISOString(),
      })
      .eq('id', drawingId)
      .eq('status', 'reviewing') // optimistic guard against a concurrent lock

    if (updateError) {
      await admin.from('drawing_secrets').delete().eq('drawing_id', drawingId)
      await admin.from('draw_snapshot_entries').delete().eq('drawing_id', drawingId)
      throw new HttpError(500, `Failed to lock drawing: ${updateError.message}`)
    }

    const totalTickets = snapshotEntrants.reduce((sum, e) => sum + e.tickets, 0)

    await writeAudit(admin, drawingId, caller, 'drawing.locked', {
      snapshot_hash: snapshotHash,
      seed_commitment: seedCommitment,
      beacon_chain: beacon.info.chainHash,
      beacon_round: beacon.round,
      beacon_expected_at: beacon.expectedAt.toISOString(),
      entrant_count: snapshotEntrants.length,
      total_tickets: totalTickets,
    })

    return json({
      ok: true,
      drawingId,
      snapshotHash,
      seedCommitment,
      beaconChain: beacon.info.chainHash,
      beaconRound: beacon.round,
      beaconExpectedAt: beacon.expectedAt.toISOString(),
      entrantCount: snapshotEntrants.length,
      totalTickets,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
