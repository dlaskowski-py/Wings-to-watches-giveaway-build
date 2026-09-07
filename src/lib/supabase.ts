import { createClient, type Session } from '@supabase/supabase-js'

/**
 * Supabase browser client.
 *
 * The publishable key below ships inside the JavaScript bundle and should be
 * treated as public. It grants nothing on its own — every table is governed by
 * Row Level Security, and `scripts/probe-rls.sh` asserts that an attacker
 * holding this exact key can read nothing but the public verification data.
 *
 * The SECRET (service_role) key must never appear in this project. It lives
 * only in the Edge Function environment. `scripts/check-bundle.sh` greps the
 * built output to make sure it never leaks in.
 */
const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!url || !publishableKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Copy .env.example to .env.local and fill both in.',
  )
}

export const supabase = createClient(url, publishableKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
})

export const SUPABASE_URL = url

/** Call the privileged drawing-actions Edge Function as the signed-in operator. */
export async function callDrawingAction(
  action: 'lock' | 'draw',
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data: sessionData } = await supabase.auth.getSession()
  const token = sessionData.session?.access_token
  if (!token) throw new Error('You are not signed in.')

  const res = await fetch(`${url}/functions/v1/drawing-actions`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, ...payload }),
  })

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`)
  }
  return body
}

export type { Session }
