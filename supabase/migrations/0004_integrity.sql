-- ===========================================================================
-- Migration 0004: derived values, state-machine rules, and immutability
--
-- These triggers are the difference between "the operator promises they didn't
-- change anything" and "the database would not let them". Everything the group
-- is asked to trust is enforced here rather than in the React app.
-- ===========================================================================

-- Allow the operator to grant entries by hand — needed to actually RESOLVE a
-- flagged remainder ("they sent $60, I'm gifting the third entry") rather than
-- just staring at the flag forever.
alter table public.payments
  add column entries_override integer check (entries_override >= 0),
  add column override_reason  text;

-- ---------------------------------------------------------------------------
-- Entry arithmetic — computed in the database, never trusted from the client
--
-- Rule (chosen by the operator): round DOWN to whole tickets and FLAG whatever
-- is left over. $60 at $25/ticket is 2 entries with $10 flagged. No automatic
-- carry-over between payments; the operator resolves each flag by hand, using
-- entries_override when they decide to be generous.
--
-- Only incoming money earns entries. Refunds and outgoing transfers are
-- direction='out' and always score zero.
-- ---------------------------------------------------------------------------
create or replace function public.compute_payment_entries()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_price integer;
  v_entries integer;
  v_remainder integer;
begin
  select d.ticket_price_cents into v_price
  from public.drawings d
  where d.id = new.drawing_id;

  if v_price is null or v_price <= 0 then
    raise exception 'Drawing % has no valid ticket price', new.drawing_id;
  end if;

  if new.direction = 'in' and new.amount_cents > 0 then
    v_entries   := new.amount_cents / v_price;      -- integer division: rounds down
    v_remainder := new.amount_cents % v_price;
  else
    v_entries   := 0;
    v_remainder := 0;
  end if;

  new.remainder_cents := v_remainder;
  new.entries := coalesce(new.entries_override, v_entries);

  -- Keep the flag array in sync with the arithmetic so the review queue can
  -- never disagree with the ledger.
  new.flags := array_remove(array_remove(new.flags, 'partial_amount'), 'entries_overridden');
  if v_remainder > 0 then
    new.flags := new.flags || 'partial_amount';
  end if;
  if new.entries_override is not null then
    new.flags := new.flags || 'entries_overridden';
  end if;

  -- Keep paid_on aligned with paid_at when the caller supplies only the timestamp.
  if new.paid_on is null and new.paid_at is not null then
    new.paid_on := (new.paid_at at time zone 'UTC')::date;
  end if;

  return new;
end;
$$;

create trigger payments_compute_entries
  before insert or update on public.payments
  for each row execute function public.compute_payment_entries();

-- ---------------------------------------------------------------------------
-- Drawing state machine + commitment immutability
-- ---------------------------------------------------------------------------
create or replace function public.guard_drawing_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_unlocking boolean;
begin
  -- An "unlock" is the one way back from `locked`, and only before a draw. It
  -- must simultaneously clear the entire published commitment, so a drawing can
  -- never sit in `reviewing` while still advertising an old snapshot hash.
  -- Anyone who saw the previous commitment will see it change; the audit log
  -- records it. Reversible before the draw, permanent after.
  v_unlocking := old.status = 'locked'
             and new.status = 'reviewing'
             and new.snapshot_hash is null
             and new.seed_commitment is null
             and new.beacon_round is null
             and new.locked_at is null;

  -- Legal transitions.
  if old.status is distinct from new.status then
    if not (
         (old.status = 'draft'     and new.status in ('reviewing', 'cancelled'))
      or (old.status = 'reviewing' and new.status in ('draft', 'locked', 'cancelled'))
      or (old.status = 'locked'    and new.status = 'drawn')
      or (old.status = 'locked'    and new.status = 'cancelled')
      or (old.status = 'drawn'     and new.status = 'published')
      or v_unlocking
    ) then
      raise exception 'Illegal drawing status transition: % -> %', old.status, new.status;
    end if;
  end if;

  -- Once drawn, the result is history. Nothing may change but publication.
  if old.status in ('drawn', 'published') then
    if new.snapshot_hash    is distinct from old.snapshot_hash
    or new.seed_commitment  is distinct from old.seed_commitment
    or new.final_seed       is distinct from old.final_seed
    or new.revealed_seed    is distinct from old.revealed_seed
    or new.beacon_round     is distinct from old.beacon_round
    or new.beacon_randomness is distinct from old.beacon_randomness
    or new.ticket_price_cents is distinct from old.ticket_price_cents
    or new.winner_count     is distinct from old.winner_count
    or new.alternate_count  is distinct from old.alternate_count
    or new.drawn_at         is distinct from old.drawn_at
    then
      raise exception 'Drawing % is already drawn; its result is immutable', old.id;
    end if;
  end if;

  -- While locked (pre-draw), the commitment is fixed unless the whole thing is
  -- being unlocked, and the draw fields may only go from null to a value.
  if old.status = 'locked' and not v_unlocking then
    if new.snapshot_hash   is distinct from old.snapshot_hash
    or new.seed_commitment is distinct from old.seed_commitment
    or new.beacon_chain    is distinct from old.beacon_chain
    or new.beacon_round    is distinct from old.beacon_round
    or new.ticket_price_cents is distinct from old.ticket_price_cents
    or new.winner_count    is distinct from old.winner_count
    or new.alternate_count is distinct from old.alternate_count
    then
      raise exception 'Drawing % is locked; its published commitment cannot be altered', old.id;
    end if;
  end if;

  return new;
end;
$$;

create trigger drawings_guard_update
  before update on public.drawings
  for each row execute function public.guard_drawing_update();

-- ---------------------------------------------------------------------------
-- Payments, entrants and aliases freeze when the drawing locks
--
-- After the entrant list is hashed and published, editing the ledger behind it
-- would make the snapshot a lie. Unlock first (which visibly retracts the
-- commitment) if a correction is genuinely needed.
-- ---------------------------------------------------------------------------
create or replace function public.guard_frozen_drawing()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status  text;
  v_drawing uuid;
begin
  -- Attached only to tables that all carry a drawing_id column, so plpgsql can
  -- resolve the field generically at runtime. Branch explicitly on TG_OP rather
  -- than being clever with COALESCE: NEW is unassigned during DELETE and OLD is
  -- unassigned during INSERT, and touching the wrong one raises at runtime.
  if tg_op = 'DELETE' then
    v_drawing := old.drawing_id;
  else
    v_drawing := new.drawing_id;
  end if;

  if v_drawing is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select d.status into v_status from public.drawings d where d.id = v_drawing;

  if v_status in ('locked', 'drawn', 'published') then
    raise exception
      'Drawing % is % — % on % is blocked. Unlock the drawing first (this publicly retracts the commitment).',
      v_drawing, v_status, tg_op, tg_table_name;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger payments_guard_frozen
  before insert or update or delete on public.payments
  for each row execute function public.guard_frozen_drawing();

create trigger entrants_guard_frozen
  before insert or update or delete on public.entrants
  for each row execute function public.guard_frozen_drawing();

create trigger entrant_aliases_guard_frozen
  before insert or update or delete on public.entrant_aliases
  for each row execute function public.guard_frozen_drawing();

create trigger import_batches_guard_frozen
  before insert or update or delete on public.import_batches
  for each row execute function public.guard_frozen_drawing();

-- ---------------------------------------------------------------------------
-- The frozen snapshot is write-once
--
-- Insert is permitted only while the drawing is still being locked; update is
-- never permitted; delete only as part of an unlock, before any draw exists.
-- ---------------------------------------------------------------------------
create or replace function public.guard_snapshot_entries()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' then
    raise exception 'Snapshot entries are immutable once written';
  end if;

  if tg_op = 'DELETE' then
    select d.status into v_status from public.drawings d where d.id = old.drawing_id;
    if v_status in ('drawn', 'published') then
      raise exception 'Cannot delete snapshot entries for a drawing that has already been drawn';
    end if;
    return old;
  end if;

  select d.status into v_status from public.drawings d where d.id = new.drawing_id;
  if v_status in ('drawn', 'published') then
    raise exception 'Cannot add snapshot entries to a drawing that has already been drawn';
  end if;
  return new;
end;
$$;

create trigger draw_snapshot_entries_guard
  before insert or update or delete on public.draw_snapshot_entries
  for each row execute function public.guard_snapshot_entries();

-- ---------------------------------------------------------------------------
-- Results are written exactly once
--
-- The only permitted later change is marking a winner forfeited and promoting
-- an alternate — and even that leaves the original ranking intact.
-- ---------------------------------------------------------------------------
create or replace function public.guard_draw_results()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Draw results cannot be deleted';
  end if;

  if tg_op = 'UPDATE' then
    if new.rank          is distinct from old.rank
    or new.public_id     is distinct from old.public_id
    or new.display_label is distinct from old.display_label
    or new.tickets       is distinct from old.tickets
    or new.is_alternate  is distinct from old.is_alternate
    or new.drawing_id    is distinct from old.drawing_id
    then
      raise exception 'Draw results are immutable; only forfeit/promote status may change';
    end if;
    return new;
  end if;

  return new;
end;
$$;

create trigger draw_results_guard
  before insert or update or delete on public.draw_results
  for each row execute function public.guard_draw_results();

-- ---------------------------------------------------------------------------
-- The audit log is append-only, full stop
-- ---------------------------------------------------------------------------
create or replace function public.guard_audit_log()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'The audit log is append-only';
end;
$$;

create trigger audit_log_guard
  before update or delete on public.audit_log
  for each row execute function public.guard_audit_log();
