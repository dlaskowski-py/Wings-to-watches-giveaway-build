-- ===========================================================================
-- Migration 0009: close gaps found by an adversarial review of the shipped
-- schema. Each block states the concrete failure it prevents.
-- ===========================================================================

-- 1. entries_override applied even to OUTGOING payments.
--
-- The snapshot builder filters direction='in', so an override on a refund
-- produced entries that reached drawing_reconciliation.total_entries but never
-- the frozen entrant list. The two numbers then disagreed — and reconciliation
-- is the operator's only defence against invented tickets. The override is now
-- honoured only for money in, and capped: unbounded was the cheapest way to
-- quietly hand somebody 10,000 tickets.
alter table public.payments drop constraint if exists payments_entries_override_check;
alter table public.payments
  add constraint payments_entries_override_check
  check (entries_override is null or (entries_override >= 0 and entries_override <= 10000));

alter table public.payments drop constraint if exists payments_amount_nonneg;
alter table public.payments
  add constraint payments_amount_nonneg check (amount_cents >= 0);

create or replace function public.compute_payment_entries()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_price integer;
  v_entries integer;
  v_remainder integer;
  v_incoming boolean;
begin
  select d.ticket_price_cents into v_price from public.drawings d where d.id = new.drawing_id;
  if v_price is null or v_price <= 0 then
    raise exception 'Drawing % has no valid ticket price', new.drawing_id;
  end if;

  v_incoming := new.direction = 'in' and new.amount_cents > 0;

  if v_incoming then
    v_entries   := new.amount_cents / v_price;   -- integer division rounds down
    v_remainder := new.amount_cents % v_price;
  else
    v_entries   := 0;
    v_remainder := 0;
  end if;

  new.remainder_cents := v_remainder;
  -- Outgoing money can never earn entries, override or not.
  new.entries := case when v_incoming then coalesce(new.entries_override, v_entries) else 0 end;

  new.flags := array_remove(array_remove(new.flags, 'partial_amount'), 'entries_overridden');
  if v_remainder > 0 then
    new.flags := new.flags || 'partial_amount'::text;
  end if;
  if new.entries_override is not null and v_incoming then
    new.flags := new.flags || 'entries_overridden'::text;
  end if;

  if new.paid_on is null and new.paid_at is not null then
    new.paid_on := (new.paid_at at time zone 'UTC')::date;
  end if;

  return new;
end;
$$;
revoke all on function public.compute_payment_entries() from anon, authenticated, public;

-- The reconciliation view was the other half of the same disagreement: it
-- summed entries regardless of direction.
create or replace view public.drawing_reconciliation
with (security_invoker = true) as
select
  d.id as drawing_id,
  d.ticket_price_cents,
  count(p.id)                                                             as total_rows,
  count(p.id) filter (where p.status = 'approved')                        as approved_count,
  count(p.id) filter (where p.status = 'needs_review')                    as needs_review_count,
  count(p.id) filter (where p.status = 'excluded')                        as excluded_count,
  count(p.id) filter (where p.status = 'duplicate')                       as duplicate_count,
  count(p.id) filter (where p.direction = 'out')                          as outgoing_count,
  count(p.id) filter (where cardinality(p.flags) > 0 and p.status = 'needs_review') as flagged_count,
  coalesce(sum(p.amount_cents) filter (where p.status = 'approved' and p.direction = 'in'), 0)::bigint as approved_cents,
  coalesce(sum(p.amount_cents) filter (where p.status = 'needs_review' and p.direction = 'in'), 0)::bigint as pending_cents,
  coalesce(sum(p.amount_cents) filter (where p.status = 'excluded'), 0)::bigint as excluded_cents,
  coalesce(sum(p.entries) filter (where p.status = 'approved' and p.direction = 'in'), 0)::bigint as total_entries,
  coalesce(sum(p.remainder_cents) filter (where p.status = 'approved' and p.direction = 'in'), 0)::bigint as unallocated_cents,
  count(distinct p.entrant_id) filter (where p.status = 'approved' and p.direction = 'in') as entrant_count
from public.drawings d
left join public.payments p on p.drawing_id = d.id
group by d.id, d.ticket_price_cents;

grant select on public.drawing_reconciliation to authenticated;

-- 2. A signed-in operator could write draw_results straight through PostgREST
--    and flip the drawing to 'drawn', fabricating a result without ever calling
--    the Edge Function. Such a draw would fail public verification — they
--    cannot forge a seed that matches the published commitment — but it should
--    not be writable at all. Results are service-role only now, and reaching
--    'drawn' requires results that only the Edge Function can create.
revoke insert on public.draw_results from authenticated;

create or replace function public.guard_drawing_update()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_unlocking boolean;
  v_results integer;
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

    if new.status = 'drawn' then
      select count(*) into v_results from public.draw_results r where r.drawing_id = new.id;
      if v_results = 0 then
        raise exception
          'A drawing cannot be marked drawn without recorded results. Run the draw through the drawing-actions function.';
      end if;
    end if;
  end if;

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

-- 3. Snapshot rows could still be INSERTed while a drawing was 'locked', which
--    would desync the published hash from the list members can see. The lock
--    function writes them while the drawing is still 'reviewing', so tightening
--    this costs nothing.
create or replace function public.guard_snapshot_entries()
returns trigger language plpgsql set search_path = '' as $$
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
  if v_status is distinct from 'reviewing' then
    raise exception
      'Snapshot entries can only be written while the drawing is being locked (status is %)', v_status;
  end if;
  return new;
end;
$$;
revoke all on function public.guard_snapshot_entries() from anon, authenticated, public;

-- 4. The append-only audit log accepted arbitrary rows from any allowlisted
--    caller, including a forged actor_email. Direct INSERT is revoked; the
--    write_audit() function stamps the actor from the caller's own token.
drop policy if exists audit_log_admin_insert on public.audit_log;
revoke insert on public.audit_log from authenticated;

-- 5. Reverting an import removed its payments but left behind the entrants and
--    aliases it created. An alias owns an identity value, so a mis-mapped first
--    import would permanently mis-route that person's later payments. Done in
--    one function so the cleanup is atomic.
create or replace function public.revert_import_batch(p_batch_id uuid, p_drawing_id uuid)
returns json language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_payments integer;
  v_entrants integer;
begin
  if not public.is_operator() then
    raise exception 'Only an operator may revert an import';
  end if;

  select status into v_status from public.drawings where id = p_drawing_id;
  if v_status is null then raise exception 'Drawing not found'; end if;
  if v_status in ('locked', 'drawn', 'published') then
    raise exception 'Drawing is % — unlock it before reverting an import', v_status;
  end if;

  delete from public.payments where batch_id = p_batch_id and drawing_id = p_drawing_id;
  get diagnostics v_payments = row_count;

  with orphaned as (
    delete from public.entrants e
    where e.drawing_id = p_drawing_id
      and not exists (select 1 from public.payments p where p.entrant_id = e.id)
    returning 1
  )
  select count(*) into v_entrants from orphaned;

  update public.import_batches
     set status = 'reverted', reverted_at = now()
   where id = p_batch_id and drawing_id = p_drawing_id;

  insert into public.audit_log (drawing_id, actor_id, actor_email, action, detail)
  values (p_drawing_id, auth.uid(), public.current_email(), 'import.reverted',
          jsonb_build_object('batch_id', p_batch_id, 'payments_removed', v_payments,
                             'entrants_removed', v_entrants));

  return json_build_object('payments_removed', v_payments, 'entrants_removed', v_entrants);
end;
$$;

revoke all on function public.revert_import_batch(uuid, uuid) from anon, public;
grant execute on function public.revert_import_batch(uuid, uuid) to authenticated;
