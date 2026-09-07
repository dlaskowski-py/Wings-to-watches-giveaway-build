-- ===========================================================================
-- Migration 0006: revoke function EXECUTE from anon
--
-- Supabase's default privileges hand EXECUTE on new public functions to anon and
-- authenticated. `revoke ... from public` in 0001/0002 did NOT undo that, so
-- every one of these was reachable anonymously over /rest/v1/rpc/.
--
-- write_audit was the one that actually mattered: an anonymous caller could
-- append arbitrary rows to the append-only audit log — the very record the group
-- is supposed to be able to trust. Found by probing the live API with the
-- publishable key; see scripts/probe-rls.sh.
-- ===========================================================================

revoke all on function public.current_email()                from anon, public;
revoke all on function public.is_admin()                     from anon, public;
revoke all on function public.is_operator()                  from anon, public;
revoke all on function public.write_audit(uuid, text, jsonb) from anon, public;
revoke all on function public.unlock_drawing(uuid, text)     from anon, public;
revoke all on function public.merge_entrants(uuid, uuid)     from anon, public;

-- Trigger functions are never invoked directly; nobody needs EXECUTE at all.
revoke all on function public.touch_updated_at()        from anon, authenticated, public;
revoke all on function public.compute_payment_entries() from anon, authenticated, public;
revoke all on function public.guard_drawing_update()    from anon, authenticated, public;
revoke all on function public.guard_frozen_drawing()    from anon, authenticated, public;
revoke all on function public.guard_snapshot_entries()  from anon, authenticated, public;
revoke all on function public.guard_draw_results()      from anon, authenticated, public;
revoke all on function public.guard_audit_log()         from anon, authenticated, public;

grant execute on function public.current_email()                to authenticated;
grant execute on function public.is_admin()                     to authenticated;
grant execute on function public.is_operator()                  to authenticated;
grant execute on function public.unlock_drawing(uuid, text)     to authenticated;
grant execute on function public.merge_entrants(uuid, uuid)     to authenticated;

-- write_audit runs as definer so it can write to an append-only table. Add an
-- explicit allowlist check inside it so being able to CALL it is not the same
-- as being allowed to write to it.
create or replace function public.write_audit(
  p_drawing_id uuid,
  p_action     text,
  p_detail     jsonb default '{}'::jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'Only an allowlisted operator may write to the audit log';
  end if;
  insert into public.audit_log (drawing_id, actor_id, actor_email, action, detail)
  values (p_drawing_id, auth.uid(), public.current_email(), p_action, coalesce(p_detail, '{}'::jsonb));
end;
$$;

revoke all on function public.write_audit(uuid, text, jsonb) from anon, public;
grant execute on function public.write_audit(uuid, text, jsonb) to authenticated;

comment on table public.drawing_secrets is
  'RLS enabled with ZERO policies BY DESIGN. Unreachable by anon and by the signed-in operator alike; only the service_role key inside the draw Edge Function can read it. The Supabase linter reports rls_enabled_no_policy here — that finding is the intended state, not an oversight.';
