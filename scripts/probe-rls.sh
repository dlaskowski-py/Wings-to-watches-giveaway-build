#!/usr/bin/env bash
#
# Adversarial RLS probe.
#
# Talks to the live PostgREST API using ONLY the publishable key — the same key
# that ships inside the browser bundle and that anyone can read out of it. Every
# line must come back "permission denied" or an empty array. Anything that
# returns real data is a leak.
#
# Run this after every migration that touches grants or policies:
#   ./scripts/probe-rls.sh
#
# Reads VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY from .env.local.
set -uo pipefail

ENV_FILE="${1:-.env.local}"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE — copy .env.example and fill it in." >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

U="${VITE_SUPABASE_URL:?}"
K="${VITE_SUPABASE_PUBLISHABLE_KEY:?}"
fail=0

check() { # <label> <curl-output> ; passes when denied or empty
  local label="$1" body="$2"
  if [[ "$body" == *"permission denied"* || "$body" == "[]" ]]; then
    printf '  ok    %-34s\n' "$label"
  else
    printf '  LEAK  %-34s %s\n' "$label" "${body:0:160}"
    fail=1
  fi
}

get() { curl -s -m 20 -H "apikey: $K" -H "Authorization: Bearer $K" "$U/rest/v1/$1"; }
rpc() { # $2 is an optional JSON body; the default must be real JSON, not shell-escaped braces
  local body="${2:-}"
  [ -z "$body" ] && body='{}'
  curl -s -m 20 -X POST -H "apikey: $K" -H "Authorization: Bearer $K" \
       -H 'Content-Type: application/json' -d "$body" "$U/rest/v1/rpc/$1"
}
post() { curl -s -m 20 -X POST -H "apikey: $K" -H "Authorization: Bearer $K" \
         -H 'Content-Type: application/json' -d "$2" "$U/rest/v1/$1"; }

echo "Anonymous read probe:"
for t in payments entrants entrant_aliases import_batches drawing_secrets \
         admin_emails audit_log merge_suggestions mapping_presets \
         entrant_ticket_counts drawing_reconciliation; do
  check "$t" "$(get "$t?select=*")"
done
check "drawings (all columns)"    "$(get 'drawings?select=*')"
check "drawings.notes"            "$(get 'drawings?select=notes')"
check "drawings.created_by"       "$(get 'drawings?select=created_by')"
check "draw_snapshot_entries.entrant_id" "$(get 'draw_snapshot_entries?select=entrant_id')"

echo "Anonymous RPC probe:"
for f in is_admin is_operator current_email; do check "rpc/$f" "$(rpc "$f")"; done
check "rpc/write_audit" "$(rpc write_audit '{"p_drawing_id":null,"p_action":"FORGED","p_detail":{}}')"
check "rpc/unlock_drawing" "$(rpc unlock_drawing '{"p_drawing_id":"00000000-0000-4000-8000-000000000000","p_reason":"probe"}')"
check "rpc/merge_entrants" "$(rpc merge_entrants '{"p_target":"00000000-0000-4000-8000-000000000000","p_source":"00000000-0000-4000-8000-000000000001"}')"

echo "Anonymous write probe:"
check "INSERT payments"     "$(post payments '{"drawing_id":"00000000-0000-4000-8000-000000000000","source":"venmo","amount_cents":1,"dedupe_hash":"x"}')"
check "INSERT admin_emails" "$(post admin_emails '{"email":"attacker@evil.com","role":"operator"}')"
check "INSERT drawings"     "$(post drawings '{"name":"attacker"}')"

echo
if [ "$fail" -eq 0 ]; then
  echo "PASS — nothing reachable anonymously beyond the public verification data."
else
  echo "FAIL — see LEAK lines above." >&2
fi
exit "$fail"
