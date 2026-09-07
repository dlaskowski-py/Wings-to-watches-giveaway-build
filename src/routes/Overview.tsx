import { useEffect, useState } from 'react'
import { FileSpreadsheet, Save, Upload } from 'lucide-react'
import { useDrawing } from './DrawingLayout'
import { listBatches, revertBatch, updateDrawing, writeAudit } from '../lib/db'
import type { ImportBatch } from '../lib/types'
import { formatCents, formatDateTime, pluralize } from '../lib/format'
import { parseAmountToCents } from '../lib/csv/amount'
import { Badge, Button, Callout, Card, EmptyState, Field, Input, LinkButton, Stat, Textarea } from '../components/ui'

export function OverviewTab() {
  const { drawing, reconciliation, reload, editable } = useDrawing()
  const [batches, setBatches] = useState<ImportBatch[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState(drawing.name)
  const [price, setPrice] = useState(formatCents(drawing.ticket_price_cents, false))
  const [winners, setWinners] = useState(String(drawing.winner_count))
  const [alternates, setAlternates] = useState(String(drawing.alternate_count))
  const [windowStart, setWindowStart] = useState(drawing.window_start ?? '')
  const [windowEnd, setWindowEnd] = useState(drawing.window_end ?? '')
  const [prize, setPrize] = useState(drawing.prize_description ?? '')

  useEffect(() => {
    listBatches(drawing.id).then(setBatches).catch(() => setBatches([]))
  }, [drawing.id])

  const parsedPrice = parseAmountToCents(price)

  async function save() {
    if (!parsedPrice.ok) return
    setSaving(true)
    setError(null)
    try {
      await updateDrawing(drawing.id, {
        name: name.trim(),
        ticket_price_cents: parsedPrice.value.cents,
        winner_count: Math.max(1, Number(winners) || 1),
        alternate_count: Math.max(0, Number(alternates) || 0),
        window_start: windowStart || null,
        window_end: windowEnd || null,
        prize_description: prize.trim() || null,
      })
      await writeAudit(drawing.id, 'drawing.settings_updated', { name: name.trim() })
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const r = reconciliation
  const pending = r?.needs_review_count ?? 0

  return (
    <div className="space-y-6">
      <Card title="Where this drawing stands">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Money approved" value={formatCents(r?.approved_cents ?? 0)} hint={`${r?.approved_count ?? 0} payments`} />
          <Stat label="Entries earned" value={(r?.total_entries ?? 0).toLocaleString()} hint={`${r?.entrant_count ?? 0} entrants`} />
          <Stat
            label="Still to review"
            value={pending.toLocaleString()}
            tone={pending > 0 ? 'warn' : 'good'}
            hint={pending > 0 ? 'Must be zero before you can lock' : 'Nothing outstanding'}
          />
          <Stat
            label="Unallocated"
            value={formatCents(r?.unallocated_cents ?? 0)}
            tone={(r?.unallocated_cents ?? 0) > 0 ? 'warn' : 'neutral'}
            hint="Money that did not reach a whole entry"
          />
        </dl>

        {r && (
          <div className="mt-4 rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-600">
            <p className="font-medium text-ink-800">Does this match your bank?</p>
            <p className="mt-1">
              {formatCents(r.approved_cents)} approved ={' '}
              <span className="tabular">{r.total_entries.toLocaleString()}</span> entries ×{' '}
              {formatCents(drawing.ticket_price_cents)} ={' '}
              <span className="tabular">{formatCents(r.total_entries * drawing.ticket_price_cents)}</span>
              {r.unallocated_cents > 0 && <> + {formatCents(r.unallocated_cents)} unallocated</>}.
              {r.pending_cents > 0 && (
                <> A further {formatCents(r.pending_cents)} is still waiting on review.</>
              )}
            </p>
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <LinkButton to="../import" variant="primary">
            <Upload className="size-4" aria-hidden />
            Import a CSV
          </LinkButton>
          <LinkButton to="../review">
            <FileSpreadsheet className="size-4" aria-hidden />
            Review payments
          </LinkButton>
          <LinkButton to="../draw">Lock &amp; draw</LinkButton>
        </div>
      </Card>

      <Card
        title="Settings"
        description={
          editable
            ? 'These are frozen into the published commitment when you lock the drawing.'
            : 'Locked. Settings can no longer change — they are part of the published commitment.'
        }
        actions={editable ? <Button variant="primary" onClick={() => void save()} loading={saving}><Save className="size-4" aria-hidden />Save</Button> : null}
      >
        <div className="space-y-5">
          <Field label="Name">
            <Input value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Price per entry" error={parsedPrice.ok ? null : 'Enter a dollar amount'}>
              <Input value={price} disabled={!editable} onChange={(e) => setPrice(e.target.value)} />
            </Field>
            <Field label="Winners">
              <Input type="number" min={1} value={winners} disabled={!editable} onChange={(e) => setWinners(e.target.value)} />
            </Field>
            <Field label="Alternates">
              <Input type="number" min={0} value={alternates} disabled={!editable} onChange={(e) => setAlternates(e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Window opens">
              <Input type="date" value={windowStart} disabled={!editable} onChange={(e) => setWindowStart(e.target.value)} />
            </Field>
            <Field label="Window closes">
              <Input type="date" value={windowEnd} disabled={!editable} onChange={(e) => setWindowEnd(e.target.value)} />
            </Field>
          </div>
          <Field label="Prize">
            <Textarea rows={2} value={prize} disabled={!editable} onChange={(e) => setPrize(e.target.value)} />
          </Field>
          {error && <Callout tone="bad">{error}</Callout>}
        </div>
      </Card>

      <Card title="Imports" description="Every CSV you have brought in. Reverting removes only that file's payments.">
        {batches === null ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : batches.length === 0 ? (
          <EmptyState title="Nothing imported yet">
            Upload a Venmo or Zelle export to get started.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-100">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-900">{b.file_name}</span>
                    <Badge tone="neutral">{b.source}</Badge>
                    {b.status === 'reverted' && <Badge tone="bad">Reverted</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-500">
                    {formatDateTime(b.created_at)} · {pluralize(b.imported_count, 'payment')} imported
                    {b.duplicate_count > 0 && `, ${b.duplicate_count} flagged as duplicates`}
                    {b.skipped_count > 0 && `, ${b.skipped_count} unreadable rows skipped`}
                  </p>
                </div>
                {editable && b.status === 'imported' && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      if (!confirm(`Remove all payments imported from ${b.file_name}? This cannot be undone.`)) return
                      await revertBatch(b.id, drawing.id)
                      await writeAudit(drawing.id, 'import.reverted', { file_name: b.file_name, batch_id: b.id })
                      setBatches(await listBatches(drawing.id))
                      await reload()
                    }}
                  >
                    Revert
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
