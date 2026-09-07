-- ===========================================================================
-- Migration 0007: BUGFIX — appending a flag to payments.flags
--
-- `text[] || 'literal'` makes Postgres parse the untyped literal as an ARRAY
-- literal, so every flag append failed at runtime with:
--   22P02 malformed array literal: "entries_overridden"
-- Casting the right operand to ::text selects the element-append operator.
--
-- This broke BOTH flag paths (partial_amount and entries_overridden), i.e. the
-- operator's chosen "round down and flag the remainder" rule did not work at
-- all. Caught by the trigger probe before any real data existed.
-- ===========================================================================

create or replace function public.compute_payment_entries()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_price integer;
  v_entries integer;
  v_remainder integer;
begin
  select d.ticket_price_cents into v_price from public.drawings d where d.id = new.drawing_id;
  if v_price is null or v_price <= 0 then
    raise exception 'Drawing % has no valid ticket price', new.drawing_id;
  end if;

  if new.direction = 'in' and new.amount_cents > 0 then
    v_entries   := new.amount_cents / v_price;   -- integer division rounds down
    v_remainder := new.amount_cents % v_price;
  else
    v_entries   := 0;
    v_remainder := 0;
  end if;

  new.remainder_cents := v_remainder;
  new.entries := coalesce(new.entries_override, v_entries);

  new.flags := array_remove(array_remove(new.flags, 'partial_amount'), 'entries_overridden');
  if v_remainder > 0 then
    new.flags := new.flags || 'partial_amount'::text;
  end if;
  if new.entries_override is not null then
    new.flags := new.flags || 'entries_overridden'::text;
  end if;

  if new.paid_on is null and new.paid_at is not null then
    new.paid_on := (new.paid_at at time zone 'UTC')::date;
  end if;

  return new;
end;
$$;

revoke all on function public.compute_payment_entries() from anon, authenticated, public;
