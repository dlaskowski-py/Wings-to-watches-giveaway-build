-- ===========================================================================
-- Migration 0003: Row Level Security and grants
--
-- Threat model: the publishable key ships inside the browser bundle, so treat
-- it as public knowledge. Everything below assumes an attacker holds that key
-- and is talking to PostgREST directly. Nothing may be reachable that is not
-- explicitly granted here.
--
-- Two audiences:
--   authenticated + on the allowlist  -> the operator console, full access
--   anon                              -> the public verification page only:
--                                        commitment values, the frozen entrant
--                                        list, and the results. No emails, no
--                                        phone numbers, no payment amounts,
--                                        no real names.
--
-- Note the `(select public.is_admin())` wrapping throughout. Without the
-- subquery, Postgres re-evaluates the function once per row; with it, the
-- planner hoists it to a one-time InitPlan. On a 5,000-row payments scan that
-- is the difference between snappy and unusable.
-- ===========================================================================

-- Supabase grants broad default privileges on new public tables. Take them all
-- back first, then hand out exactly what each role needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

alter table public.admin_emails          enable row level security;
alter table public.drawings              enable row level security;
alter table public.drawing_secrets       enable row level security;
alter table public.entrants              enable row level security;
alter table public.entrant_aliases       enable row level security;
alter table public.import_batches        enable row level security;
alter table public.payments              enable row level security;
alter table public.merge_suggestions     enable row level security;
alter table public.mapping_presets       enable row level security;
alter table public.draw_snapshot_entries enable row level security;
alter table public.draw_results          enable row level security;
alter table public.audit_log             enable row level security;

-- ---------------------------------------------------------------------------
-- drawing_secrets: RLS enabled, ZERO policies, ZERO grants.
--
-- Deny-by-default means neither anon nor the signed-in operator can reach the
-- secret seed through the API. Only the service_role key held by the Edge
-- Function bypasses RLS. This is intentional and load-bearing — see the table
-- comment in 0001.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- admin_emails — readable by admins so the console can show who has access.
-- Managed from the Supabase dashboard, so no write policy is exposed.
-- ---------------------------------------------------------------------------
grant select on public.admin_emails to authenticated;

create policy admin_emails_select on public.admin_emails
  for select to authenticated
  using ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- drawings
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.drawings to authenticated;

create policy drawings_admin_all on public.drawings
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- Public verification: only the columns a verifier actually needs, and only
-- once the drawing is locked (i.e. the commitment has been published).
grant select (
  id, name, status, ticket_price_cents, winner_count, alternate_count,
  prize_description, snapshot_hash, seed_commitment, beacon_chain, beacon_round,
  beacon_expected_at, beacon_randomness, final_seed, revealed_seed,
  random_words_used, locked_at, drawn_at, published_at
) on public.drawings to anon;

create policy drawings_public_select on public.drawings
  for select to anon
  using (status in ('locked', 'drawn', 'published'));

-- ---------------------------------------------------------------------------
-- entrants / aliases — operator only. These carry real names, emails, phones.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.entrants to authenticated;
grant select, insert, update, delete on public.entrant_aliases to authenticated;

create policy entrants_admin_all on public.entrants
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy entrant_aliases_admin_all on public.entrant_aliases
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- import_batches / payments — operator only. Payment amounts never go public.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.import_batches to authenticated;
grant select, insert, update, delete on public.payments to authenticated;

create policy import_batches_admin_all on public.import_batches
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy payments_admin_all on public.payments
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- merge_suggestions / mapping_presets — operator only
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on public.merge_suggestions to authenticated;
grant select, insert, update, delete on public.mapping_presets to authenticated;

create policy merge_suggestions_admin_all on public.merge_suggestions
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy mapping_presets_admin_all on public.mapping_presets
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- draw_snapshot_entries
--
-- Public from lock onward. Exposing the frozen list BEFORE the draw is the
-- point: it lets members confirm their own ticket count while the outcome is
-- still unknown, which is far more convincing than showing it afterwards.
-- `entrant_id` is withheld so the public list cannot be joined back to PII.
-- ---------------------------------------------------------------------------
grant select, insert, delete on public.draw_snapshot_entries to authenticated;
grant select (drawing_id, public_id, display_label, tickets) on public.draw_snapshot_entries to anon;

create policy draw_snapshot_admin_all on public.draw_snapshot_entries
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy draw_snapshot_public_select on public.draw_snapshot_entries
  for select to anon
  using (exists (
    select 1 from public.drawings d
    where d.id = draw_snapshot_entries.drawing_id
      and d.status in ('locked', 'drawn', 'published')
  ));

-- ---------------------------------------------------------------------------
-- draw_results — public once drawn
-- ---------------------------------------------------------------------------
grant select, insert, update on public.draw_results to authenticated;
grant select (drawing_id, rank, public_id, display_label, tickets, is_alternate, status, status_note)
  on public.draw_results to anon;

create policy draw_results_admin_all on public.draw_results
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

create policy draw_results_public_select on public.draw_results
  for select to anon
  using (exists (
    select 1 from public.drawings d
    where d.id = draw_results.drawing_id
      and d.status in ('drawn', 'published')
  ));

-- ---------------------------------------------------------------------------
-- audit_log — admins may read and append; nobody may edit or erase.
-- ---------------------------------------------------------------------------
grant select, insert on public.audit_log to authenticated;

create policy audit_log_admin_select on public.audit_log
  for select to authenticated
  using ((select public.is_admin()));

create policy audit_log_admin_insert on public.audit_log
  for insert to authenticated
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------------------
-- Future-proofing: anything added to this schema later starts locked down
-- rather than inheriting Supabase's permissive defaults.
-- ---------------------------------------------------------------------------
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
