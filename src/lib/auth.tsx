import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { supabase } from './supabase'
import type { Session } from '@supabase/supabase-js'

/**
 * Auth state.
 *
 * Sign-in is a magic link: there is no password to lose, and access is
 * controlled by the `admin_emails` allowlist in the database rather than by who
 * knows a secret. Anyone may create an account against a public Supabase
 * project, so being signed in means nothing on its own — `isAdmin` reflects the
 * allowlist, and the database enforces the same rule via RLS regardless of what
 * this component believes.
 */
interface AuthState {
  session: Session | null
  email: string | null
  isAdmin: boolean
  loading: boolean
  signInWithEmail: (email: string) => Promise<void>
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
    supabase
      .rpc('is_admin')
      .then(({ data, error }) => {
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
      email: session?.user.email ?? null,
      isAdmin,
      loading,
      async signInWithEmail(email: string) {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: window.location.origin },
        })
        if (error) throw new Error(error.message)
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
