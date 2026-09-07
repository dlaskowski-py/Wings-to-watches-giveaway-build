import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { Button, Field, Input } from '../components/ui'
import { Wordmark } from '../components/brand'

export function SignInPage() {
  const { signInWithPasscode } = useAuth()
  const [passcode, setPasscode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signInWithPasscode(passcode.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 text-center">
            <h1 className="text-xl font-semibold text-ink-900">Wings to Watches</h1>
            <p className="mt-1 text-sm text-ink-500">Giveaway console</p>
          </div>

          <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-6 shadow-sm ring-1 ring-ink-200/70">
            <Field label="Passcode" htmlFor="passcode" hint="Ask whoever set this up if you don't have it.">
              <Input
                id="passcode"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="••••••••••••"
              />
            </Field>

            {error && <p className="text-xs font-medium text-red-600">{error}</p>}

            <Button type="submit" variant="primary" loading={busy} className="w-full" disabled={!passcode.trim()}>
              <KeyRound className="size-4" aria-hidden />
              Open the console
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-ink-400">
            The passcode unlocks real member data — names, contact details and payment amounts.
            Treat it like the key to the account.
          </p>
        </div>
      </div>

      <BrandFooterSlim />
    </div>
  )
}

function BrandFooterSlim() {
  return (
    <footer className="border-t border-ink-200 bg-white px-6 py-5">
      <div className="mx-auto flex max-w-sm items-center justify-center gap-1.5 text-xs text-ink-500">
        Made by <Wordmark size="sm" />
      </div>
    </footer>
  )
}
