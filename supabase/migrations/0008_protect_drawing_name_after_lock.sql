-- ===========================================================================
-- Migration 0008: BUGFIX — freeze the fields that are hashed into the snapshot
--
-- `drawings.name` is part of the canonically-serialised snapshot (it is hashed
-- into snapshot_hash so a snapshot cannot be re-pointed at a different
-- drawing), but the immutability trigger did not protect it. Renaming a locked
-- or drawn drawing therefore left the published snapshot_hash unreproducible:
-- every verifier would recompute a different hash and the draw would look
-- tampered with, even though nothing dishonest had happened.
--
-- Also freezes window_start/window_end, which determine eligibility.
-- ===========================================================================

create or replace function public.guard_drawing_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_unlocking boolean;
begin
  v_unlocking := old.status = 'locked'
             and new.status = 'reviewing'
             and new.snapshot_hash is null
             and new.seed_commitment is null
             and new.beacon_round is null
             and new.locked_at is null;

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

  -- `name` is hashed into the snapshot, so it is frozen from lock onward in
  -- both branches below.
  if old.status in ('drawn', 'published') then
    if new.name              is distinct from old.name
    or new.window_start      is distinct from old.window_start
    or new.window_end        is distinct from old.window_end
    or new.snapshot_hash     is distinct from old.snapshot_hash
    or new.seed_commitment   is distinct from old.seed_commitment
    or new.final_seed        is distinct from old.final_seed
    or new.revealed_seed     is distinct from old.revealed_seed
    or new.beacon_round      is distinct from old.beacon_round
    or new.beacon_chain      is distinct from old.beacon_chain
    or new.beacon_randomness is distinct from old.beacon_randomness
    or new.ticket_price_cents is distinct from old.ticket_price_cents
    or new.winner_count      is distinct from old.winner_count
    or new.alternate_count   is distinct from old.alternate_count
    or new.locked_at         is distinct from old.locked_at
    or new.drawn_at          is distinct from old.drawn_at
    then
      raise exception 'Drawing % is already drawn; its result is immutable', old.id;
    end if;
  end if;

  if old.status = 'locked' and not v_unlocking then
    if new.name            is distinct from old.name
    or new.window_start    is distinct from old.window_start
    or new.window_end      is distinct from old.window_end
    or new.snapshot_hash   is distinct from old.snapshot_hash
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

revoke all on function public.guard_drawing_update() from anon, authenticated, public;
