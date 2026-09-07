import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { createDrawing, writeAudit } from '../lib/db'
import { parseAmountToCents } from '../lib/csv/amount'
import { Button, Callout, Card, Field, Input, Textarea } from '../components/ui'
import { AppShell } from './DrawingLayout'

/** Suggest "2026 Q3 Giveaway" from today's date so the operator rarely types it. */
function defaultName(): string {
  const now = new Date()
  return `${now.getFullYear()} Q${Math.floor(now.getMonth() / 3) + 1} Giveaway`
}

function quarterBounds(): { start: string; end: string } {
  const now = new Date()
  const q = Math.floor(now.getMonth() / 3)
  const startMonth = q * 3
  const start = new Date(Date.UTC(now.getFullYear(), startMonth, 1))
  const end = new Date(Date.UTC(now.getFullYear(), startMonth + 3, 0))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

export function NewDrawingPage() {
  const navigate = useNavigate()
  const bounds = quarterBounds()

  const [name, setName] = useState(defaultName())
  const [price, setPrice] = useState('25.00')
  const [winners, setWinners] = useState('1')
  const [alternates, setAlternates] = useState('3')
  const [windowStart, setWindowStart] = useState(bounds.start)
  const [windowEnd, setWindowEnd] = useState(bounds.end)
  const [prize, setPrize] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parsedPrice = parseAmountToCents(price)
  const priceError = parsedPrice.ok ? null : 'Enter a dollar amount, e.g. 25.00'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!parsedPrice.ok) return
    setBusy(true)
    setError(null)
    try {
      const drawing = await createDrawing({
        name: name.trim(),
        ticket_price_cents: parsedPrice.value.cents,
        winner_count: Math.max(1, Number(winners) || 1),
        alternate_count: Math.max(0, Number(alternates) || 0),
        window_start: windowStart || null,
        window_end: windowEnd || null,
        prize_description: prize.trim() || null,
      })
      await writeAudit(drawing.id, 'drawing.created', { name: drawing.name })
      navigate(`/d/${drawing.id}/import`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <AppShell>
      <div className="mx-auto max-w-2xl">
        <h1 className="text-lg font-semibold text-ink-900">New drawing</h1>
        <p className="mt-0.5 mb-6 text-sm text-ink-500">
          These settings are frozen when you lock the drawing, so they end up in the published commitment.
        </p>

        <form onSubmit={submit}>
          <Card>
            <div className="space-y-5">
              <Field label="Name" htmlFor="name" hint="Shown to the group on the public verification page.">
                <Input id="name" required value={name} onChange={(e) => setName(e.target.value)} />
              </Field>

              <div className="grid gap-5 sm:grid-cols-3">
                <Field label="Price per entry" htmlFor="price" error={priceError}>
                  <Input id="price" required value={price} onChange={(e) => setPrice(e.target.value)} />
                </Field>
                <Field label="Winners" htmlFor="winners" hint="Prizes to award.">
                  <Input id="winners" type="number" min={1} max={100} value={winners} onChange={(e) => setWinners(e.target.value)} />
                </Field>
                <Field label="Alternates" htmlFor="alternates" hint="Ranked backups.">
                  <Input
                    id="alternates"
                    type="number"
                    min={0}
                    max={100}
                    value={alternates}
                    onChange={(e) => setAlternates(e.target.value)}
                  />
                </Field>
              </div>

              <Callout tone="info" title="Why draw alternates?">
                They are drawn in the same pass and published alongside the winners. If a winner turns out to be
                unreachable you promote the next alternate from a list the group has already seen — instead of
                running a fresh private draw that nobody can check.
              </Callout>

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Payment window opens" htmlFor="ws" hint="Payments outside the window are flagged, never dropped.">
                  <Input id="ws" type="date" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} />
                </Field>
                <Field label="Payment window closes" htmlFor="we">
                  <Input id="we" type="date" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} />
                </Field>
              </div>

              <Field label="Prize" htmlFor="prize" hint="Optional. Appears on the public results page.">
                <Textarea id="prize" rows={2} value={prize} onChange={(e) => setPrize(e.target.value)} />
              </Field>

              {error && <p className="text-sm font-medium text-red-600">{error}</p>}
            </div>
          </Card>

          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={() => navigate('/')}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!parsedPrice.ok}>
              Create and import payments
            </Button>
          </div>
        </form>
      </div>
    </AppShell>
  )
}
