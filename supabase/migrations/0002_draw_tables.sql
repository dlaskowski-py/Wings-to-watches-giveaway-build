-- ===========================================================================
-- Migration 0002: the frozen draw snapshot, the results, and the audit log
--
-- Everything here is written exactly once, by the Edge Function, and is then
-- immutable (enforced in 0004). These are the tables a sceptical group member
-- reads when they want to check the draw themselves.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The frozen entrant list
--
-- Written at LOCK time and never touched again. `canonicalizeSnapshot()` in
-- src/lib/draw/core.ts turns exactly these rows into the document whose SHA-256
-- becomes drawings.snapshot_hash. Column names and types deliberately mirror
-- the SnapshotEntrant TypeScript interface.
--
-- entrant_id links back to the operator-side record. It is NOT granted to anon.
-- ---------------------------------------------------------------------------
create table public.draw_snapshot_entries (
  drawing_id     uuid not null references public.drawings (id) on delete cascade,
  public_id      uuid not null,
  display_label  text not null check (length(btrim(display_label)) > 0
                                      and display_label !~ '[\t\n\r]'),
  tickets        integer not null check (tickets > 0),
  entrant_id     uuid references public.entrants (id) on delete set null,
  created_at     timestamptz not null default now(),

  primary key (drawing_id, public_id)
);

create index draw_snapshot_entries_drawing_idx on public.draw_snapshot_entries (drawing_id);

comment on table public.draw_snapshot_entries is
  'Immutable frozen entrant list hashed into drawings.snapshot_hash at lock time.';

-- ---------------------------------------------------------------------------
-- Results
--
-- Ranks 1..winner_count are prize winners; higher ranks are alternates drawn in
-- the same pass. Publishing alternates up front means a winner who turns out to
-- be unreachable is replaced from a list the group already saw, instead of by a
-- fresh private draw that nobody can verify.
-- ---------------------------------------------------------------------------
create table public.draw_results (
  drawing_id     uuid not null references public.drawings (id) on delete cascade,
  rank           integer not null check (rank > 0),
  public_id      uuid not null,
  display_label  text not null,
  tickets        integer not null check (tickets > 0),
  is_alternate   boolean not null default false,

  -- Set only if a winner is disqualified/unreachable and an alternate is
  -- promoted. Recording it here keeps the original draw intact and auditable
  -- rather than rewriting history.
  status         text not null default 'active'
                   check (status in ('active', 'forfeited', 'promoted')),
  status_note    text,
  status_changed_at timestamptz,

  created_at     timestamptz not null default now(),

  primary key (drawing_id, rank),
  unique (drawing_id, public_id)
);

create index draw_results_drawing_idx on public.draw_results (drawing_id, rank);

-- ---------------------------------------------------------------------------
-- Append-only audit log
--
-- Every state transition and every operator decision that changes somebody's
-- odds lands here. Update and delete are revoked in 0003, and a trigger in 0004
-- blocks them even for table owners reaching through the API.
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  drawing_id   uuid references public.drawings (id) on delete set null,
  actor_id     uuid references auth.users (id) on delete set null,
  actor_email  text,
  action       text not null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index audit_log_drawing_idx on public.audit_log (drawing_id, created_at desc);
create index audit_log_created_idx on public.audit_log (created_at desc);

-- Convenience writer that stamps the acting user automatically.
create or replace function public.write_audit(
  p_drawing_id uuid,
  p_action     text,
  p_detail     jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (drawing_id, actor_id, actor_email, action, detail)
  values (p_drawing_id, auth.uid(), public.current_email(), p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.write_audit(uuid, text, jsonb) from public;
grant execute on function public.write_audit(uuid, text, jsonb) to authenticated;
