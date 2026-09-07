-- ===========================================================================
-- Migration 0005: reconciliation views and the unlock routine
--
-- `security_invoker = true` on every view, so the caller's RLS still applies.
-- A default (definer) view here would quietly hand anon the operator's data.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tickets per entrant — the input to the frozen snapshot
--
-- Only `approved` payments count. Anything still in needs_review, or marked
-- excluded or duplicate, contributes nothing.
-- ---------------------------------------------------------------------------
create view public.entrant_ticket_counts
with (security_invoker = true) as
select
  p.drawing_id,
  p.entrant_id,
  sum(p.entries)::integer        as tickets,
  sum(p.amount_cents)::bigint    as paid_cents,
  sum(p.remainder_cents)::bigint as remainder_cents,
  count(*)::integer              as payment_count,
  min(p.paid_on)                 as first_paid_on,
  max(p.paid_on)                 as last_paid_on
from public.payments p
where p.status = 'approved'
  and p.entrant_id is not null
  and p.direction = 'in'
group by p.drawing_id, p.entrant_id;

grant select on public.entrant_ticket_counts to authenticated;

-- ---------------------------------------------------------------------------
-- The reconciliation panel
--
-- This exists to answer one question the operator asks every quarter: "does
-- this match what actually hit my account?" Hence both the money that earned
-- tickets AND the money that did not are surfaced, rather than only the tidy
-- total.
-- ---------------------------------------------------------------------------
create view public.drawing_reconciliation
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
  count(p.id) filter (where cardinality(p.flags) > 0
                        and p.status = 'needs_review')                    as flagged_count,

  coalesce(sum(p.amount_cents) filter (where p.status = 'approved' and p.direction = 'in'), 0)::bigint
                                                                          as approved_cents,
  coalesce(sum(p.amount_cents) filter (where p.status = 'needs_review' and p.direction = 'in'), 0)::bigint
                                                                          as pending_cents,
  coalesce(sum(p.amount_cents) filter (where p.status = 'excluded'), 0)::bigint
                                                                          as excluded_cents,
  coalesce(sum(p.entries) filter (where p.status = 'approved'), 0)::bigint
                                                                          as total_entries,
  coalesce(sum(p.remainder_cents) filter (where p.status = 'approved'), 0)::bigint
                                                                          as unallocated_cents,

  count(distinct p.entrant_id) filter (where p.status = 'approved')       as entrant_count
from public.drawings d
left join public.payments p on p.drawing_id = d.id
group by d.id, d.ticket_price_cents;

grant select on public.drawing_reconciliation to authenticated;

-- ---------------------------------------------------------------------------
-- Unlocking
--
-- The only route back from `locked`, and only before a draw. It retracts the
-- entire published commitment in one transaction — snapshot rows, snapshot
-- hash, seed commitment, beacon round and the secret seed all go together — so
-- the drawing can never sit in `reviewing` while still advertising a stale
-- commitment. It is loudly audited, because a member who already saw the old
-- commitment deserves to be able to ask why it changed.
-- ---------------------------------------------------------------------------
create or replace function public.unlock_drawing(p_drawing_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_old_hash text;
  v_old_commitment text;
  v_old_round bigint;
begin
  if not public.is_operator() then
    raise exception 'Only an operator may unlock a drawing';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 5 then
    raise exception 'Unlocking requires a written reason (it retracts a published commitment)';
  end if;

  select status, snapshot_hash, seed_commitment, beacon_round
    into v_status, v_old_hash, v_old_commitment, v_old_round
  from public.drawings
  where id = p_drawing_id
  for update;

  if v_status is null then
    raise exception 'Drawing % not found', p_drawing_id;
  end if;
  if v_status <> 'locked' then
    raise exception 'Only a locked drawing can be unlocked (this one is %)', v_status;
  end if;

  delete from public.draw_snapshot_entries where drawing_id = p_drawing_id;
  delete from public.drawing_secrets       where drawing_id = p_drawing_id;

  update public.drawings
     set status             = 'reviewing',
         snapshot_hash      = null,
         seed_commitment    = null,
         beacon_chain       = null,
         beacon_round       = null,
         beacon_expected_at = null,
         locked_at          = null
   where id = p_drawing_id;

  insert into public.audit_log (drawing_id, actor_id, actor_email, action, detail)
  values (
    p_drawing_id, auth.uid(), public.current_email(), 'drawing.unlocked',
    jsonb_build_object(
      'reason', p_reason,
      'retracted_snapshot_hash', v_old_hash,
      'retracted_seed_commitment', v_old_commitment,
      'retracted_beacon_round', v_old_round
    )
  );
end;
$$;

revoke all on function public.unlock_drawing(uuid, text) from public;
grant execute on function public.unlock_drawing(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Merge two entrants
--
-- Moves every payment and alias from the source onto the target, then deletes
-- the now-empty source. Done in SQL so it is atomic: a half-applied merge would
-- silently drop somebody's tickets.
-- ---------------------------------------------------------------------------
create or replace function public.merge_entrants(p_target uuid, p_source uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drawing uuid;
  v_source_drawing uuid;
  v_status text;
  v_moved integer;
begin
  if not public.is_operator() then
    raise exception 'Only an operator may merge entrants';
  end if;
  if p_target = p_source then
    raise exception 'Cannot merge an entrant into themselves';
  end if;

  select drawing_id into v_drawing        from public.entrants where id = p_target;
  select drawing_id into v_source_drawing from public.entrants where id = p_source;

  if v_drawing is null or v_source_drawing is null then
    raise exception 'Both entrants must exist';
  end if;
  if v_drawing <> v_source_drawing then
    raise exception 'Cannot merge entrants across different drawings';
  end if;

  select status into v_status from public.drawings where id = v_drawing;
  if v_status in ('locked', 'drawn', 'published') then
    raise exception 'Drawing is % — unlock it before merging entrants', v_status;
  end if;

  update public.payments set entrant_id = p_target where entrant_id = p_source;
  get diagnostics v_moved = row_count;

  -- Aliases are unique per (drawing, kind, value); drop any that would collide
  -- with one the target already owns, then re-point the rest.
  delete from public.entrant_aliases a
   where a.entrant_id = p_source
     and exists (
       select 1 from public.entrant_aliases b
       where b.entrant_id = p_target and b.kind = a.kind and b.value_norm = a.value_norm
     );
  update public.entrant_aliases set entrant_id = p_target where entrant_id = p_source;

  update public.merge_suggestions
     set status = 'accepted', resolved_by = auth.uid(), resolved_at = now()
   where drawing_id = v_drawing
     and status = 'pending'
     and (entrant_a in (p_target, p_source) and entrant_b in (p_target, p_source));

  delete from public.entrants where id = p_source;

  insert into public.audit_log (drawing_id, actor_id, actor_email, action, detail)
  values (
    v_drawing, auth.uid(), public.current_email(), 'entrants.merged',
    jsonb_build_object('target', p_target, 'source', p_source, 'payments_moved', v_moved)
  );
end;
$$;

revoke all on function public.merge_entrants(uuid, uuid) from public;
grant execute on function public.merge_entrants(uuid, uuid) to authenticated;
