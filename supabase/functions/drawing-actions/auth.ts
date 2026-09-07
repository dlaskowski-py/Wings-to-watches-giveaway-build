/**
 * Caller authentication for the draw functions.
 *
 * Supabase already validates the JWT signature (verify_jwt is on). What it does
 * NOT do is check that the signed-in user is allowed to touch a drawing — any
 * stranger can create an account against a public project. So every function
 * re-checks the caller's email against the admin allowlist using the service
 * role, and refuses otherwise.
 */
import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export function serviceClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

export interface Caller {
  id: string
  email: string
  role: string
}

/** Resolve the caller and confirm they are an allowlisted operator. */
export async function requireOperator(req: Request, admin: SupabaseClient): Promise<Caller> {
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new HttpError(401, 'Missing Authorization header')

  const { data, error } = await admin.auth.getUser(token)
  if (error || !data.user) throw new HttpError(401, 'Not signed in')

  const email = (data.user.email ?? '').toLowerCase()
  if (!email) throw new HttpError(403, 'Account has no email address')

  const { data: allow, error: allowError } = await admin
    .from('admin_emails')
    .select('email, role')
    .eq('email', email)
    .maybeSingle()

  if (allowError) throw new HttpError(500, `Allowlist lookup failed: ${allowError.message}`)
  if (!allow) throw new HttpError(403, `${email} is not on the operator allowlist`)
  if (allow.role !== 'operator') throw new HttpError(403, 'This action requires the operator role')

  return { id: data.user.id, email, role: allow.role }
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status)
  const message = err instanceof Error ? err.message : String(err)
  console.error('Unhandled error:', message)
  return json({ error: message }, 500)
}

export async function writeAudit(
  admin: SupabaseClient,
  drawingId: string,
  caller: Caller,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from('audit_log').insert({
    drawing_id: drawingId,
    actor_id: caller.id,
    actor_email: caller.email,
    action,
    detail,
  })
  if (error) console.error(`audit write failed (${action}): ${error.message}`)
}
