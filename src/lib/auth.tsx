import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'

/**
 * Shared-passcode sign-in.
 *
 * The passcode is NOT checked in the browser. It could not be: the publishable
 * Supabase key ships inside this bundle, so anyone could skip the interface
 * entirely and query PostgREST for every member's name, email, phone number and
 * payment amount. A passcode the frontend validates by itself would be theatre.
 *
 * Instead the passcode is the *password* of one fixed Supabase account. Signing
 * in exchanges it for a real JWT, and Row Level Security does the actual
 * enforcement in the database — exactly as it did under the previous magic-link
 * scheme. Knowing the publishable key gets an attacker nothing without the
 * passcode, and Supabase Auth rate-limits guesses.
 *
 * The account address below is not a secret; it is a fixed identifier, and the
 * passcode is the only thing that matters. No email is ever sent to it.
 *
 * To change the passcode: Supabase dashboard -> Authentication -> Users ->
 * console@wings-to-watches.app -> Reset password. It takes effect immediately
 * and signs everyone else out at their next token refresh.
 */
export const CONSOLE_ACCOUNT_EMAIL = 'console@wings-to-watches.app'

interface AuthState {
  session: Session | null
  /** True when the signed-in account is on the database allowlist. */
  isAdmin: boolean
  loading: boolean
  signInWithPasscode: (passcode: string) => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setLoading(false)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!session) {
      setIsAdmin(false)
      return
    }
    let active = true
    supabase.rpc('is_admin').then(({ data, error }) => {
      if (!active) return
      setIsAdmin(!error && data === true)
    })
    return () => {
      active = false
    }
  }, [session])

  const value = useMemo<AuthState>(
    () => ({
      session,
      isAdmin,
      loading,
      async signInWithPasscode(passcode: string) {
        const { error } = await supabase.auth.signInWithPassword({
          email: CONSOLE_ACCOUNT_EMAIL,
          password: passcode,
        })
        if (error) {
          // Supabase says "Invalid login credentials", which is confusing when
          // the only thing the person typed was a passcode.
          throw new Error(
            /invalid login credentials/i.test(error.message)
              ? 'That passcode is not right.'
              : error.message,
          )
        }
      },
      async signOut() {
        await supabase.auth.signOut()
      },
    }),
    [session, isAdmin, loading],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
