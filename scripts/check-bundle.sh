#!/usr/bin/env bash
#
# Guard against shipping a secret in the browser bundle.
#
# The publishable Supabase key is SUPPOSED to be in there — it is public by
# design and RLS is what protects the data. The service_role key is the
# opposite: it bypasses RLS entirely, so if it ever reached dist/ the whole
# security model would be void. This check makes that failure loud instead of
# silent.
#
# Run after every build:  ./scripts/check-bundle.sh
set -uo pipefail

DIST="${1:-dist}"
[ -d "$DIST" ] || { echo "No $DIST directory — run 'npm run build' first." >&2; exit 1; }

fail=0
report() { echo "  LEAK  $1"; fail=1; }

echo "Scanning $DIST for secrets:"

# Supabase secret/service-role keys: the modern sb_secret_ prefix, and legacy
# JWTs whose payload declares the service_role role.
if grep -rqE 'sb_secret_[A-Za-z0-9_-]+' "$DIST"; then
  report "a sb_secret_… key is present"
fi
if grep -rq 'service_role' "$DIST"; then
  report "the string 'service_role' is present"
fi
# A legacy service-role JWT base64-encodes {"role":"service_role"}.
if grep -rq 'InNlcnZpY2Vfcm9sZSI' "$DIST"; then
  report "a base64-encoded service_role JWT claim is present"
fi
# Generic private-key material.
if grep -rq 'BEGIN [A-Z ]*PRIVATE KEY' "$DIST"; then
  report "a PEM private key is present"
fi
# The .env file itself should never be copied into the build output.
if find "$DIST" -name '.env*' | grep -q .; then
  report "an .env file was copied into the bundle"
fi

if [ "$fail" -eq 0 ]; then
  echo "  ok    no service-role key or private key material in the bundle"
  echo
  echo "PASS"
else
  echo
  echo "FAIL — a secret reached the browser bundle. Do not deploy." >&2
fi
exit "$fail"
