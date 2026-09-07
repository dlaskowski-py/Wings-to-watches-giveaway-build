-- ===========================================================================
-- Wings to Watches — quarterly giveaway system
-- Migration 0001: core schema
--
-- Money is stored as INTEGER CENTS everywhere. Never float, never numeric-with-
-- rounding-surprises. $25.00 is 2500. This is non-negotiable: the whole product
-- exists so the operator can tie totals out against a real bank statement.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Admin allowlist
--
-- Allowlisting is by EMAIL rather than by user id, because the operator needs
-- to authorise a person before that person has ever signed in (there is no
-- auth.users row to point at yet). Anyone may create an account; without a row
-- here they can read absolutely nothing, which is enforced in the database by
-- RLS rather than merely hidden in the UI.
-- ---------------------------------------------------------------------------
create table public.admin_emails (
  email       text primary key check (email = lower(email) and position('@' in email) > 1),
  role        text not null default 'operator' check (role in ('operator', 'viewer')),
  note        text,
  added_at    timestamptz not null default now()
);

comment on table public.admin_emails is
  'Allowlist of email addresses permitted to use the operator console. Seed the first row manually via the Supabase SQL editor.';

-- Email of the caller, lowercased, or '' for anonymous requests.
create or replace function public.current_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- security definer so the policy check can read admin_emails without needing a
-- policy on admin_emails itself (which would be circular).
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_emails a
    where a.email = public.current_email()
  );
$$;

create or replace function public.is_operator()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.admin_emails a
    where a.email = public.current_email()
      and a.role = 'operator'
  );
$$;

revoke all on function public.current_email() from public;
revoke all on function public.is_admin() from public;
revoke all on function public.is_operator() from public;
grant execute on function public.current_email() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_operator() to authenticated;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Drawings — one row per quarter
--
-- Lifecycle:
--   draft      operator is setting it up; nothing imported yet
--   reviewing  CSVs imported; operator is verifying payments and entries
--   locked     entrant list frozen; snapshot hash + seed commitment published;
--              waiting for the committed drand beacon round to be emitted
--   drawn      winners selected and recorded; seed revealed
--   published  results shared with the group
--   cancelled  abandoned
--
-- Everything from `locked` onward is protected by triggers in 0004.
-- ---------------------------------------------------------------------------
create table public.drawings (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null check (length(btrim(name)) between 1 and 120),
  status              text not null default 'draft'
                        check (status in ('draft', 'reviewing', 'locked', 'drawn', 'published', 'cancelled')),

  ticket_price_cents  integer not null default 2500 check (ticket_price_cents > 0),
  winner_count        integer not null default 1 check (winner_count between 1 and 100),
  alternate_count     integer not null default 3 check (alternate_count between 0 and 100),

  -- Payments dated outside this window are flagged for review, never silently dropped.
  window_start        date,
  window_end          date,
  prize_description   text,
  notes               text,

  -- Commit–reveal fields. All null until lock.
  snapshot_hash       text check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  seed_commitment     text check (seed_commitment ~ '^[0-9a-f]{64}$'),
  beacon_chain        text,
  beacon_round        bigint check (beacon_round > 0),
  beacon_expected_at  timestamptz,

  -- Populated at draw time.
  beacon_randomness   text check (beacon_randomness ~ '^[0-9a-f]+$'),
  final_seed          text check (final_seed ~ '^[0-9a-f]{64}$'),
  revealed_seed       text check (revealed_seed ~ '^[0-9a-f]{64}$'),
  random_words_used   integer,

  locked_at           timestamptz,
  drawn_at            timestamptz,
  published_at        timestamptz,

  created_by          uuid references auth.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint drawings_window_ordered check (window_start is null or window_end is null or window_start <= window_end),
  -- A locked drawing must carry a complete, publishable commitment.
  constraint drawings_lock_complete check (
    status in ('draft', 'reviewing', 'cancelled')
    or (snapshot_hash is not null and seed_commitment is not null
        and beacon_chain is not null and beacon_round is not null and locked_at is not null)
  ),
  -- A drawn drawing must carry a complete, verifiable reveal.
  constraint drawings_draw_complete check (
    status not in ('drawn', 'published')
    or (beacon_randomness is not null and final_seed is not null
        and revealed_seed is not null and drawn_at is not null)
  )
);

create index drawings_status_idx on public.drawings (status);
create index drawings_created_at_idx on public.drawings (created_at desc);

create trigger drawings_touch before update on public.drawings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Secret seeds
--
-- Deliberately a separate table with RLS on and ZERO policies, so it is
-- unreachable through the API by anon and authenticated alike — including the
-- operator. Only the service_role key inside the Edge Function can read it.
--
-- This matters: if the operator could read the seed before the beacon lands,
-- they could privately simulate the outcome and decide whether to "cancel"
-- the drawing. Keeping it out of their reach removes the temptation entirely.
-- The seed moves to drawings.revealed_seed only once the draw is recorded.
-- ---------------------------------------------------------------------------
create table public.drawing_secrets (
  drawing_id   uuid primary key references public.drawings (id) on delete cascade,
  secret_seed  text not null check (secret_seed ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Entrants — deduplicated humans within one drawing
--
-- Scoped per drawing rather than global: quarters are independent, ticket counts
-- must not leak across them, and a fresh public_id each quarter avoids building
-- a long-lived cross-quarter identifier for members.
-- ---------------------------------------------------------------------------
create table public.entrants (
  id             uuid primary key default gen_random_uuid(),
  drawing_id     uuid not null references public.drawings (id) on delete cascade,

  -- Random per-drawing identifier used in the public snapshot. Carries no PII.
  public_id      uuid not null default gen_random_uuid(),

  -- Operator-facing full name.
  display_name   text not null check (length(btrim(display_name)) > 0),
  -- Public-facing, low-disclosure label, e.g. "Daniel L.".
  display_label  text not null check (length(btrim(display_label)) > 0
                                      and display_label !~ '[\t\n\r]'),

  primary_email  text,
  primary_phone  text,
  notes          text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  unique (drawing_id, public_id)
);

create index entrants_drawing_idx on public.entrants (drawing_id);
create index entrants_display_name_idx on public.entrants (drawing_id, lower(display_name));

create trigger entrants_touch before update on public.entrants
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Entrant aliases — every identity string a human has paid under
--
-- The unique constraint on (drawing_id, kind, value_norm) is what makes
-- auto-matching safe: one normalised identity can belong to exactly one
-- entrant, so a second payment from the same handle always lands on the same
-- person rather than quietly creating a duplicate entrant.
-- ---------------------------------------------------------------------------
create table public.entrant_aliases (
  id          uuid primary key default gen_random_uuid(),
  drawing_id  uuid not null references public.drawings (id) on delete cascade,
  entrant_id  uuid not null references public.entrants (id) on delete cascade,
  kind        text not null check (kind in ('name', 'email', 'phone', 'handle')),
  value_raw   text not null,
  value_norm  text not null check (length(value_norm) > 0),
  created_at  timestamptz not null default now(),

  unique (drawing_id, kind, value_norm)
);

create index entrant_aliases_entrant_idx on public.entrant_aliases (entrant_id);

-- ---------------------------------------------------------------------------
-- Import batches — one row per uploaded CSV
-- ---------------------------------------------------------------------------
create table public.import_batches (
  id                uuid primary key default gen_random_uuid(),
  drawing_id        uuid not null references public.drawings (id) on delete cascade,

  source            text not null check (source in ('venmo', 'zelle', 'other')),
  source_label      text,
  file_name         text not null,
  file_size_bytes   integer,
  -- SHA-256 of the raw file, so re-uploading the identical export is caught
  -- immediately rather than row by row.
  file_sha256       text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),

  column_mapping    jsonb not null default '{}'::jsonb,

  row_count         integer not null default 0,
  imported_count    integer not null default 0,
  duplicate_count   integer not null default 0,
  skipped_count     integer not null default 0,

  status            text not null default 'imported' check (status in ('imported', 'reverted')),
  reverted_at       timestamptz,

  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now()
);

create index import_batches_drawing_idx on public.import_batches (drawing_id, created_at desc);
create index import_batches_file_hash_idx on public.import_batches (drawing_id, file_sha256);

-- ---------------------------------------------------------------------------
-- Payments — the normalised ledger, one row per CSV row that looks like money
--
-- `raw_row` keeps the complete original record forever. When a member disputes
-- their ticket count nine months later, the answer has to be reconstructible
-- from what the bank actually exported, not from our interpretation of it.
-- ---------------------------------------------------------------------------
create table public.payments (
  id                uuid primary key default gen_random_uuid(),
  drawing_id        uuid not null references public.drawings (id) on delete cascade,
  batch_id          uuid references public.import_batches (id) on delete set null,
  entrant_id        uuid references public.entrants (id) on delete set null,

  source            text not null check (source in ('venmo', 'zelle', 'other', 'manual')),

  -- Normalised payer identity as extracted from the row.
  raw_payer_name    text,
  payer_name        text,
  payer_email       text,
  payer_phone       text,
  payer_handle      text,

  paid_at           timestamptz,
  paid_on           date,

  amount_cents      integer not null,
  -- 'in' is money received (counts toward entries); 'out' is money leaving
  -- (refunds, the operator paying someone) and never counts.
  direction         text not null default 'in' check (direction in ('in', 'out')),

  note              text,
  external_ref      text,
  raw_row           jsonb not null default '{}'::jsonb,
  source_row_number integer,

  -- Derived. Recomputed by trigger; see 0004.
  entries           integer not null default 0 check (entries >= 0),
  remainder_cents   integer not null default 0 check (remainder_cents >= 0),

  status            text not null default 'needs_review'
                      check (status in ('needs_review', 'approved', 'excluded', 'duplicate')),
  exclude_reason    text,
  flags             text[] not null default '{}',

  -- Content hash used to catch the same payment arriving twice across
  -- overlapping exports. `occurrence` allows a genuine second identical payment
  -- to coexist once the operator confirms it is real.
  dedupe_hash       text not null,
  occurrence        integer not null default 0 check (occurrence >= 0),

  reviewed_by       uuid references auth.users (id) on delete set null,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (drawing_id, dedupe_hash, occurrence)
);

create index payments_drawing_idx on public.payments (drawing_id);
create index payments_drawing_status_idx on public.payments (drawing_id, status);
create index payments_entrant_idx on public.payments (entrant_id);
create index payments_batch_idx on public.payments (batch_id);
create index payments_flags_idx on public.payments using gin (flags);
create index payments_paid_on_idx on public.payments (drawing_id, paid_on);

create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Identity merge suggestions
--
-- Fuzzy matches are SUGGESTED, never applied. Silently merging "Dan L" into
-- "Daniel Laskowski" would quietly change somebody's odds, which is precisely
-- the kind of invisible decision this system exists to prevent.
-- ---------------------------------------------------------------------------
create table public.merge_suggestions (
  id            uuid primary key default gen_random_uuid(),
  drawing_id    uuid not null references public.drawings (id) on delete cascade,
  entrant_a     uuid not null references public.entrants (id) on delete cascade,
  entrant_b     uuid not null references public.entrants (id) on delete cascade,
  score         numeric(4, 3) not null check (score >= 0 and score <= 1),
  reason        text not null,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  resolved_by   uuid references auth.users (id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now(),

  constraint merge_suggestions_distinct check (entrant_a <> entrant_b),
  -- Ordered pair, so (A,B) and (B,A) cannot both be queued.
  constraint merge_suggestions_ordered check (entrant_a < entrant_b),
  unique (drawing_id, entrant_a, entrant_b)
);

create index merge_suggestions_pending_idx on public.merge_suggestions (drawing_id, status);

-- ---------------------------------------------------------------------------
-- Saved column mappings
--
-- Zelle exports come from each member's own bank, so the operator will meet a
-- new layout regularly. Presets make the second import of any given format a
-- one-click affair.
-- ---------------------------------------------------------------------------
create table public.mapping_presets (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  source            text not null check (source in ('venmo', 'zelle', 'other')),
  mapping           jsonb not null,
  -- Sorted, normalised header list; used to auto-suggest this preset next time.
  header_signature  text,
  is_builtin        boolean not null default false,
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  unique (name, source)
);

create index mapping_presets_signature_idx on public.mapping_presets (header_signature);

create trigger mapping_presets_touch before update on public.mapping_presets
  for each row execute function public.touch_updated_at();
