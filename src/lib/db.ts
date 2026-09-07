/**
 * Data access.
 *
 * Everything goes through PostgREST with the publishable key, so RLS is what
 * actually enforces access — these helpers are for convenience and typing, not
 * for security. Nothing here may be relied on as a permission check.
 */
import { supabase } from './supabase'
import type {
  AuditEntry,
  DrawResultRow,
  Drawing,
  Entrant,
  EntrantAlias,
  EntrantTicketCount,
  ImportBatch,
  MappingPreset,
  MergeSuggestion,
  Payment,
  Reconciliation,
  SnapshotEntry,
} from './types'

function unwrap<T>(result: { data: T | null; error: { message: string } | null }, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`)
  if (result.data === null) throw new Error(`${context}: no data returned`)
  return result.data
}

/**
 * PostgREST caps every response at 1000 rows and gives no indication that it
 * truncated. At this project's scale that is not theoretical: ~1000 members
 * with several payments each, and up to four identity aliases per person, both
 * blow straight past it. A silently short read here would mean people losing
 * tickets from the frozen snapshot, so EVERY list that can exceed 1000 rows
 * must page.
 */
const PAGE_SIZE = 1000

async function fetchAllPages<T>(
  context: string,
  // Loosely typed on purpose: a narrowed `.select('a, b')` produces a row shape
  // that does not structurally match the domain type, and the cast belongs here
  // once rather than at every call site.
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const batch = unwrap(await page(from, from + PAGE_SIZE - 1), context) as T[]
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

/* ---------------------------------------------------------------- drawings */

export async function listDrawings(): Promise<Drawing[]> {
  return unwrap(
    await supabase.from('drawings').select('*').order('created_at', { ascending: false }),
    'Loading drawings',
  ) as Drawing[]
}

export async function getDrawing(id: string): Promise<Drawing> {
  return unwrap(await supabase.from('drawings').select('*').eq('id', id).single(), 'Loading drawing') as Drawing
}

export async function createDrawing(input: {
  name: string
  ticket_price_cents: number
  winner_count: number
  alternate_count: number
  window_start: string | null
  window_end: string | null
  prize_description: string | null
}): Promise<Drawing> {
  const { data: userData } = await supabase.auth.getUser()
  return unwrap(
    await supabase
      .from('drawings')
      .insert({ ...input, status: 'reviewing', created_by: userData.user?.id ?? null })
      .select('*')
      .single(),
    'Creating drawing',
  ) as Drawing
}

export async function updateDrawing(id: string, patch: Partial<Drawing>): Promise<Drawing> {
  return unwrap(
    await supabase.from('drawings').update(patch).eq('id', id).select('*').single(),
    'Updating drawing',
  ) as Drawing
}

export async function unlockDrawing(id: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc('unlock_drawing', { p_drawing_id: id, p_reason: reason })
  if (error) throw new Error(`Unlocking drawing: ${error.message}`)
}

export async function publishDrawing(id: string): Promise<Drawing> {
  return updateDrawing(id, { status: 'published', published_at: new Date().toISOString() })
}

/* ---------------------------------------------------------------- payments */

export async function listPayments(drawingId: string): Promise<Payment[]> {
  return fetchAllPages<Payment>('Loading payments', (from, to) =>
    supabase
      .from('payments')
      .select('*')
      .eq('drawing_id', drawingId)
      .order('paid_on', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: true })
      .range(from, to),
  )
}

export async function insertPayments(rows: Array<Partial<Payment>>): Promise<Payment[]> {
  const inserted: Payment[] = []
  // Chunked so a large import does not exceed the request body limit.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500)
    inserted.push(
      ...(unwrap(await supabase.from('payments').insert(chunk).select('*'), 'Saving payments') as Payment[]),
    )
  }
  return inserted
}

export async function updatePayment(id: string, patch: Partial<Payment>): Promise<Payment> {
  const { data: userData } = await supabase.auth.getUser()
  return unwrap(
    await supabase
      .from('payments')
      .update({ ...patch, reviewed_by: userData.user?.id ?? null, reviewed_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single(),
    'Updating payment',
  ) as Payment
}

export async function updatePaymentsBulk(ids: string[], patch: Partial<Payment>): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { error } = await supabase
      .from('payments')
      .update({ ...patch, reviewed_by: userData.user?.id ?? null, reviewed_at: new Date().toISOString() })
      .in('id', chunk)
    if (error) throw new Error(`Bulk update: ${error.message}`)
  }
}

export async function existingDedupeHashes(drawingId: string): Promise<Set<string>> {
  const rows = await fetchAllPages<{ dedupe_hash: string }>('Loading existing payment hashes', (from, to) =>
    supabase.from('payments').select('dedupe_hash').eq('drawing_id', drawingId).range(from, to),
  )
  return new Set(rows.map((r) => r.dedupe_hash))
}

/**
 * Highest `occurrence` already stored for each dedupe hash in this drawing.
 *
 * The unique key is (drawing_id, dedupe_hash, occurrence), so a third genuinely
 * identical payment needs occurrence = 2. Assigning a flat 1 to every duplicate
 * makes the whole import fail on the third one.
 */
export async function existingOccurrences(drawingId: string): Promise<Map<string, number>> {
  const rows = await fetchAllPages<{ dedupe_hash: string; occurrence: number }>(
    'Loading payment occurrences',
    (from, to) =>
      supabase.from('payments').select('dedupe_hash, occurrence').eq('drawing_id', drawingId).range(from, to),
  )
  const highest = new Map<string, number>()
  for (const r of rows) {
    const current = highest.get(r.dedupe_hash)
    if (current === undefined || r.occurrence > current) highest.set(r.dedupe_hash, r.occurrence)
  }
  return highest
}

/* ---------------------------------------------------------------- entrants */

export async function listEntrants(drawingId: string): Promise<Entrant[]> {
  return fetchAllPages<Entrant>('Loading entrants', (from, to) =>
    supabase.from('entrants').select('*').eq('drawing_id', drawingId).order('display_name').range(from, to),
  )
}

export async function listAliases(drawingId: string): Promise<EntrantAlias[]> {
  // Up to four aliases per person (name, email, phone, handle), so a
  // 1000-member quarter can hold several thousand rows.
  return fetchAllPages<EntrantAlias>('Loading entrant aliases', (from, to) =>
    supabase.from('entrant_aliases').select('*').eq('drawing_id', drawingId).order('id').range(from, to),
  )
}

export async function createEntrant(input: {
  drawing_id: string
  display_name: string
  display_label: string
  primary_email?: string | null
  primary_phone?: string | null
}): Promise<Entrant> {
  return unwrap(await supabase.from('entrants').insert(input).select('*').single(), 'Creating entrant') as Entrant
}

export async function updateEntrant(id: string, patch: Partial<Entrant>): Promise<Entrant> {
  return unwrap(
    await supabase.from('entrants').update(patch).eq('id', id).select('*').single(),
    'Updating entrant',
  ) as Entrant
}

export async function insertAliases(rows: Array<Partial<EntrantAlias>>): Promise<void> {
  if (rows.length === 0) return
  for (let i = 0; i < rows.length; i += 500) {
    // Duplicates are expected (the same person pays repeatedly), and the unique
    // constraint is what routes a repeat payment to the same entrant, so an
    // existing alias is a success rather than an error.
    const { error } = await supabase
      .from('entrant_aliases')
      .upsert(rows.slice(i, i + 500), { onConflict: 'drawing_id,kind,value_norm', ignoreDuplicates: true })
    if (error) throw new Error(`Saving aliases: ${error.message}`)
  }
}

export async function mergeEntrants(targetId: string, sourceId: string): Promise<void> {
  const { error } = await supabase.rpc('merge_entrants', { p_target: targetId, p_source: sourceId })
  if (error) throw new Error(`Merging entrants: ${error.message}`)
}

export async function listTicketCounts(drawingId: string): Promise<EntrantTicketCount[]> {
  return fetchAllPages<EntrantTicketCount>('Loading ticket counts', (from, to) =>
    supabase.from('entrant_ticket_counts').select('*').eq('drawing_id', drawingId).order('entrant_id').range(from, to),
  )
}

/* ------------------------------------------------------- merge suggestions */

export async function listMergeSuggestions(drawingId: string): Promise<MergeSuggestion[]> {
  return fetchAllPages<MergeSuggestion>('Loading merge suggestions', (from, to) =>
    supabase
      .from('merge_suggestions')
      .select('*')
      .eq('drawing_id', drawingId)
      .eq('status', 'pending')
      .order('score', { ascending: false })
      .range(from, to),
  )
}

export async function upsertMergeSuggestions(rows: Array<Partial<MergeSuggestion>>): Promise<void> {
  if (rows.length === 0) return
  const { error } = await supabase
    .from('merge_suggestions')
    .upsert(rows, { onConflict: 'drawing_id,entrant_a,entrant_b', ignoreDuplicates: true })
  if (error) throw new Error(`Saving merge suggestions: ${error.message}`)
}

export async function resolveMergeSuggestion(id: string, status: 'accepted' | 'rejected'): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('merge_suggestions')
    .update({ status, resolved_by: userData.user?.id ?? null, resolved_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`Resolving suggestion: ${error.message}`)
}

/* ----------------------------------------------------------------- batches */

export async function listBatches(drawingId: string): Promise<ImportBatch[]> {
  return unwrap(
    await supabase.from('import_batches').select('*').eq('drawing_id', drawingId).order('created_at', { ascending: false }),
    'Loading import history',
  ) as ImportBatch[]
}

export async function createBatch(input: Partial<ImportBatch>): Promise<ImportBatch> {
  const { data: userData } = await supabase.auth.getUser()
  return unwrap(
    await supabase
      .from('import_batches')
      .insert({ ...input, created_by: userData.user?.id ?? null })
      .select('*')
      .single(),
    'Recording import batch',
  ) as ImportBatch
}

/**
 * Undo an import.
 *
 * Runs as one database function so the cleanup is atomic: it removes the
 * payments AND any entrants the import invented that now have no payments at
 * all. Leaving those behind was a real bug — an alias owns an identity value,
 * so a mis-mapped first import would permanently mis-route that person's later
 * payments to the wrong entrant.
 */
export async function revertBatch(
  batchId: string,
  drawingId: string,
): Promise<{ payments_removed: number; entrants_removed: number }> {
  const { data, error } = await supabase.rpc('revert_import_batch', {
    p_batch_id: batchId,
    p_drawing_id: drawingId,
  })
  if (error) throw new Error(`Reverting import: ${error.message}`)
  return (data as { payments_removed: number; entrants_removed: number }) ?? { payments_removed: 0, entrants_removed: 0 }
}

/* ----------------------------------------------------------------- presets */

export async function listPresets(): Promise<MappingPreset[]> {
  return unwrap(await supabase.from('mapping_presets').select('*').order('name'), 'Loading presets') as MappingPreset[]
}

export async function savePreset(input: {
  name: string
  source: 'venmo' | 'zelle' | 'other'
  mapping: unknown
  header_signature: string | null
}): Promise<void> {
  const { data: userData } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('mapping_presets')
    .upsert({ ...input, created_by: userData.user?.id ?? null }, { onConflict: 'name,source' })
  if (error) throw new Error(`Saving preset: ${error.message}`)
}

/* ------------------------------------------------------- snapshot, results */

export async function listSnapshotEntries(drawingId: string): Promise<SnapshotEntry[]> {
  return fetchAllPages<SnapshotEntry>('Loading frozen entrant list', (from, to) =>
    supabase
      .from('draw_snapshot_entries')
      .select('drawing_id, public_id, display_label, tickets')
      .eq('drawing_id', drawingId)
      .order('public_id')
      .range(from, to),
  )
}

export async function listDrawResults(drawingId: string): Promise<DrawResultRow[]> {
  return unwrap(
    await supabase.from('draw_results').select('*').eq('drawing_id', drawingId).order('rank'),
    'Loading results',
  ) as DrawResultRow[]
}

export async function setResultStatus(
  drawingId: string,
  rank: number,
  status: 'active' | 'forfeited' | 'promoted',
  note: string,
): Promise<void> {
  const { error } = await supabase
    .from('draw_results')
    .update({ status, status_note: note, status_changed_at: new Date().toISOString() })
    .eq('drawing_id', drawingId)
    .eq('rank', rank)
  if (error) throw new Error(`Updating result: ${error.message}`)
}

/* ------------------------------------------------- reconciliation & audit */

export async function getReconciliation(drawingId: string): Promise<Reconciliation | null> {
  const { data, error } = await supabase
    .from('drawing_reconciliation')
    .select('*')
    .eq('drawing_id', drawingId)
    .maybeSingle()
  if (error) throw new Error(`Loading reconciliation: ${error.message}`)
  return (data as Reconciliation | null) ?? null
}

export async function listAudit(drawingId: string): Promise<AuditEntry[]> {
  return unwrap(
    await supabase
      .from('audit_log')
      .select('*')
      .eq('drawing_id', drawingId)
      .order('created_at', { ascending: false })
      .limit(200),
    'Loading audit log',
  ) as AuditEntry[]
}

export async function writeAudit(drawingId: string, action: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('write_audit', {
    p_drawing_id: drawingId,
    p_action: action,
    p_detail: detail,
  })
  // Audit failures must never block the operator's actual work; surface in the
  // console and carry on.
  if (error) console.warn(`Audit write failed (${action}): ${error.message}`)
}
