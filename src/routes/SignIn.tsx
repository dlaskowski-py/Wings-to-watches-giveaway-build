import { useState } from 'react'
import { Mail } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Button, Callout, Field, Input } from '../components/ui'

export function SignInPage() {
  const { signInWithEmail } = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signInWithEmail(email.trim())
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-xl font-semibold text-ink-900">Wings to Watches</h1>
          <p className="mt-1 text-sm text-ink-500">Giveaway console</p>
        </div>

        {sent ? (
          <Callout tone="good" title="Check your email">
            We sent a sign-in link to <span className="font-medium">{email}</span>. Open it on this device to
            continue. The link is single-use and expires shortly.
          </Callout>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-200/70">
            <Field
              label="Email address"
              htmlFor="email"
              hint="You'll get a one-time sign-in link. No password to remember."
            >
              <Input
                id="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>

            {error && <p className="text-xs font-medium text-red-600">{error}</p>}

            <Button type="submit" variant="primary" loading={busy} className="w-full">
              <Mail className="size-4" aria-hidden />
              Email me a sign-in link
            </Button>

            <p className="text-center text-xs text-ink-400">
              Only addresses on the operator allowlist can open the console.
            </p>
          </form>
        )}
      </div>
    </div>
  )
}
