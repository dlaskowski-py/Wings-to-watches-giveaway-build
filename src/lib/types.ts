/**
 * Domain types mirroring the database schema.
 *
 * Hand-written rather than generated: the generated file is thousands of lines
 * of conditional types for a schema of a dozen tables, and this codebase reads
 * better with the shapes stated plainly. Regenerate and diff against this file
 * after any migration (`generate_typescript_types`) if you want to be sure.
 */

export type DrawingStatus = 'draft' | 'reviewing' | 'locked' | 'drawn' | 'published' | 'cancelled'
export type PaymentStatus = 'needs_review' | 'approved' | 'excluded' | 'duplicate'
export type PaymentDirection = 'in' | 'out'
export type PaymentSourceDb = 'venmo' | 'zelle' | 'other' | 'manual'

export interface Drawing {
  id: string
  name: string
  status: DrawingStatus
  ticket_price_cents: number
  winner_count: number
  alternate_count: number
  window_start: string | null
  window_end: string | null
  prize_description: string | null
  notes: string | null
  snapshot_hash: string | null
  seed_commitment: string | null
  beacon_chain: string | null
  beacon_round: number | null
  beacon_expected_at: string | null
  beacon_randomness: string | null
  final_seed: string | null
  revealed_seed: string | null
  random_words_used: number | null
  locked_at: string | null
  drawn_at: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

export interface Payment {
  id: string
  drawing_id: string
  batch_id: string | null
  entrant_id: string | null
  source: PaymentSourceDb
  raw_payer_name: string | null
  payer_name: string | null
  payer_email: string | null
  payer_phone: string | null
  payer_handle: string | null
  paid_at: string | null
  paid_on: string | null
  amount_cents: number
  direction: PaymentDirection
  note: string | null
  external_ref: string | null
  raw_row: Record<string, string>
  source_row_number: number | null
  entries: number
  entries_override: number | null
  override_reason: string | null
  remainder_cents: number
  status: PaymentStatus
  exclude_reason: string | null
  flags: string[]
  dedupe_hash: string
  occurrence: number
  created_at: string
  updated_at: string
}

export interface Entrant {
  id: string
  drawing_id: string
  public_id: string
  display_name: string
  display_label: string
  primary_email: string | null
  primary_phone: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface EntrantAlias {
  id: string
  drawing_id: string
  entrant_id: string
  kind: 'name' | 'email' | 'phone' | 'handle'
  value_raw: string
  value_norm: string
}

export interface ImportBatch {
  id: string
  drawing_id: string
  source: 'venmo' | 'zelle' | 'other'
  source_label: string | null
  file_name: string
  file_size_bytes: number | null
  file_sha256: string
  column_mapping: unknown
  row_count: number
  imported_count: number
  duplicate_count: number
  skipped_count: number
  status: 'imported' | 'reverted'
  created_at: string
}

export interface MergeSuggestion {
  id: string
  drawing_id: string
  entrant_a: string
  entrant_b: string
  score: number
  reason: string
  status: 'pending' | 'accepted' | 'rejected'
}

export interface MappingPreset {
  id: string
  name: string
  source: 'venmo' | 'zelle' | 'other'
  mapping: unknown
  header_signature: string | null
  is_builtin: boolean
}

export interface SnapshotEntry {
  drawing_id: string
  public_id: string
  display_label: string
  tickets: number
  entrant_id: string | null
}

export interface DrawResultRow {
  drawing_id: string
  rank: number
  public_id: string
  display_label: string
  tickets: number
  is_alternate: boolean
  status: 'active' | 'forfeited' | 'promoted'
  status_note: string | null
}

export interface Reconciliation {
  drawing_id: string
  ticket_price_cents: number
  total_rows: number
  approved_count: number
  needs_review_count: number
  excluded_count: number
  duplicate_count: number
  outgoing_count: number
  flagged_count: number
  approved_cents: number
  pending_cents: number
  excluded_cents: number
  total_entries: number
  unallocated_cents: number
  entrant_count: number
}

export interface EntrantTicketCount {
  drawing_id: string
  entrant_id: string
  tickets: number
  paid_cents: number
  remainder_cents: number
  payment_count: number
  first_paid_on: string | null
  last_paid_on: string | null
}

export interface AuditEntry {
  id: number
  drawing_id: string | null
  actor_email: string | null
  action: string
  detail: Record<string, unknown>
  created_at: string
}

/** Labels and copy for the drawing lifecycle, used by the status banner. */
export const DRAWING_STATUS_META: Record<
  DrawingStatus,
  { label: string; tone: 'neutral' | 'info' | 'warn' | 'good'; blurb: string }
> = {
  draft: {
    label: 'Draft',
    tone: 'neutral',
    blurb: 'Set the ticket price, prize and payment window, then import your CSVs.',
  },
  reviewing: {
    label: 'Reviewing',
    tone: 'info',
    blurb: 'Import CSVs and check every payment. You can still change anything.',
  },
  locked: {
    label: 'Locked',
    tone: 'warn',
    blurb:
      'The entrant list is frozen and the commitment is published. Share it with the group, then draw once the beacon lands.',
  },
  drawn: {
    label: 'Drawn',
    tone: 'good',
    blurb: 'Winners are recorded permanently and the seed is revealed. Anyone can verify the result.',
  },
  published: {
    label: 'Published',
    tone: 'good',
    blurb: 'Results have been shared with the group.',
  },
  // The key is the Postgres enum value and keeps the database's spelling;
  // only the words shown on screen follow the kit's US English.
  cancelled: { label: 'Canceled', tone: 'neutral', blurb: 'This drawing was canceled.' },
}
