import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Merge, Search, Sparkles, X } from 'lucide-react'
import { useDrawing } from './DrawingLayout'
import {
  listEntrants, listMergeSuggestions, listTicketCounts, mergeEntrants,
  resolveMergeSuggestion, updateEntrant, upsertMergeSuggestions, writeAudit,
} from '../lib/db'
import type { Entrant, EntrantTicketCount, MergeSuggestion } from '../lib/types'
import { MERGE_SUGGESTION_THRESHOLD, compareNames, toDisplayLabel } from '../lib/csv/identity'
import { formatCents, pluralize } from '../lib/format'
import { exportEntrantsCsv } from '../lib/export'
import {
  Badge, Button, Callout, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Stat,
} from '../components/ui'

export function EntrantsTab() {
  const { drawing, reload, editable } = useDrawing()
  const [entrants, setEntrants] = useState<Entrant[] | null>(null)
  const [tickets, setTickets] = useState<EntrantTicketCount[]>([])
  const [suggestions, setSuggestions] = useState<MergeSuggestion[]>([])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(async () => {
    try {
      const [e, t, s] = await Promise.all([
        listEntrants(drawing.id), listTicketCounts(drawing.id), listMergeSuggestions(drawing.id),
      ])
      setEntrants(e)
      setTickets(t)
      setSuggestions(s)
      setError(null)
    } catch (err) {
      setError(err)
    }
  }, [drawing.id])

  useEffect(() => { void load() }, [load])

  const ticketsByEntrant = useMemo(() => new Map(tickets.map((t) => [t.entrant_id, t])), [tickets])
  const entrantById = useMemo(() => new Map((entrants ?? []).map((e) => [e.id, e])), [entrants])

  /**
   * Look for pairs of entrants that are probably the same human.
   *
   * Deliberately a SUGGESTION step the operator triggers and approves, never an
   * automatic merge: combining two entrants changes how many tickets somebody
   * holds, and a silent change to somebody's odds is exactly what this system
   * exists to prevent.
   */
  async function scanForDuplicates() {
    if (!entrants) return
    setScanning(true)
    try {
      const pairs: Array<Partial<MergeSuggestion>> = []
      for (let i = 0; i < entrants.length; i++) {
        for (let j = i + 1; j < entrants.length; j++) {
          const a = entrants[i]!
          const b = entrants[j]!
          const match = compareNames(a.display_name, b.display_name)
          if (match.score < MERGE_SUGGESTION_THRESHOLD) continue
          // The table constraint requires entrant_a < entrant_b so (A,B) and
          // (B,A) cannot both be queued.
          const [first, second] = a.id < b.id ? [a, b] : [b, a]
          pairs.push({
            drawing_id: drawing.id,
            entrant_a: first.id,
            entrant_b: second.id,
            score: Math.round(match.score * 1000) / 1000,
            reason: match.reason,
          })
        }
      }
      await upsertMergeSuggestions(pairs)
      await load()
    } catch (err) {
      setError(err)
    } finally {
      setScanning(false)
    }
  }

  async function acceptMerge(suggestion: MergeSuggestion) {
    const a = entrantById.get(suggestion.entrant_a)
    const b = entrantById.get(suggestion.entrant_b)
    if (!a || !b) return
    // Keep the one with more tickets as the target so fewer rows move, and so
    // the surviving record is the better-established identity.
    const aTickets = ticketsByEntrant.get(a.id)?.tickets ?? 0
    const bTickets = ticketsByEntrant.get(b.id)?.tickets ?? 0
    const [target, source] = aTickets >= bTickets ? [a, b] : [b, a]

    if (!confirm(`Merge "${source.display_name}" into "${target.display_name}"?\n\nAll of their payments and tickets combine onto one entrant. This cannot be undone automatically.`)) return

    setBusy(true)
    try {
      await mergeEntrants(target.id, source.id)
      await load()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorBlock error={error} />
  if (entrants === null) return <LoadingBlock label="Loading entrants…" />

  const filtered = entrants.filter((e) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [e.display_name, e.display_label, e.primary_email, e.primary_phone].some((v) => v?.toLowerCase().includes(q))
  })

  const totalTickets = tickets.reduce((sum, t) => sum + t.tickets, 0)
  const withTickets = tickets.filter((t) => t.tickets > 0).length

  return (
    <div className="space-y-6">
      <Card title="Entrants" description="One row per person. Tickets come from their approved payments.">
        <dl className="grid gap-3 sm:grid-cols-3">
          <Stat label="People" value={entrants.length.toLocaleString()} hint={`${withTickets} hold at least one ticket`} />
          <Stat label="Tickets in the pool" value={totalTickets.toLocaleString()} />
          <Stat
            label="Possible duplicates"
            value={suggestions.length.toLocaleString()}
            tone={suggestions.length > 0 ? 'warn' : 'good'}
            hint={suggestions.length > 0 ? 'Waiting on your decision' : 'None outstanding'}
          />
        </dl>
      </Card>

      {/* --------------------------------------------------- merge queue --- */}
      <Card
        title="Possible duplicate people"
        description="Zelle and Venmo name people differently. These pairs look like the same person — you decide."
        actions={
          editable ? (
            <Button size="sm" onClick={() => void scanForDuplicates()} loading={scanning}>
              <Sparkles className="size-3.5" aria-hidden />
              Scan for duplicates
            </Button>
          ) : null
        }
      >
        {suggestions.length === 0 ? (
          <EmptyState title="Nothing queued">
            Run a scan after importing to look for people who appear twice under slightly different names.
            Exact matches are merged automatically at import; this catches the rest.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-100">
            {suggestions.map((s) => {
              const a = entrantById.get(s.entrant_a)
              const b = entrantById.get(s.entrant_b)
              if (!a || !b) return null
              const aT = ticketsByEntrant.get(a.id)?.tickets ?? 0
              const bT = ticketsByEntrant.get(b.id)?.tickets ?? 0
              return (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm text-ink-900">
                      <span className="font-medium">{a.display_name}</span>
                      <span className="mx-2 text-ink-400">and</span>
                      <span className="font-medium">{b.display_name}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-ink-500">
                      {s.reason} · {pluralize(aT, 'ticket')} and {pluralize(bT, 'ticket')} ·{' '}
                      confidence {(s.score * 100).toFixed(0)}%
                    </p>
                  </div>
                  {editable && (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" variant="primary" loading={busy} onClick={() => void acceptMerge(s)}>
                        <Merge className="size-3.5" aria-hidden />
                        Same person
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await resolveMergeSuggestion(s.id, 'rejected')
                          await load()
                        }}
                      >
                        <X className="size-3.5" aria-hidden />
                        Different people
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* -------------------------------------------------------- roster --- */}
      <Card
        title="Roster"
        description="The public label is what the group sees on the verification page — enough to find yourself, not a directory."
        actions={
          <Button
            size="sm"
            onClick={() =>
              exportEntrantsCsv(
                drawing,
                filtered.map((e) => ({
                  entrant: e,
                  tickets: ticketsByEntrant.get(e.id)?.tickets ?? 0,
                  paidCents: ticketsByEntrant.get(e.id)?.paid_cents ?? 0,
                  paymentCount: ticketsByEntrant.get(e.id)?.payment_count ?? 0,
                })),
              )
            }
          >
            <Download className="size-3.5" aria-hidden />
            Export
          </Button>
        }
      >
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
          <Input className="pl-9" placeholder="Search entrants…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {filtered.length === 0 ? (
          <EmptyState title="No entrants yet">Import a CSV — entrants are created automatically from payers.</EmptyState>
        ) : (
          <div className="scroll-x rounded-lg ring-1 ring-ink-200">
            <table className="min-w-full text-sm">
              <thead className="bg-ink-50 text-xs font-semibold uppercase tracking-column text-ink-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Public label</th>
                  <th className="px-3 py-2 text-left font-medium">Contact</th>
                  <th className="px-3 py-2 text-right font-medium">Payments</th>
                  <th className="px-3 py-2 text-right font-medium">Paid</th>
                  <th className="px-3 py-2 text-right font-medium">Tickets</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {filtered.map((e) => {
                  const t = ticketsByEntrant.get(e.id)
                  return (
                    <tr key={e.id}>
                      <td className="px-3 py-2 font-medium text-ink-900">{e.display_name}</td>
                      <td className="px-3 py-2">
                        {editable ? (
                          <input
                            defaultValue={e.display_label}
                            key={`${e.id}-${e.display_label}`}
                            aria-label={`Public label for ${e.display_name}`}
                            className="w-32 rounded border-0 bg-transparent px-1 py-0.5 ring-1 ring-inset ring-transparent hover:ring-ink-200 focus:bg-white focus:ring-brand-500"
                            onBlur={async (ev) => {
                              const next = ev.target.value.trim() || toDisplayLabel(e.display_name)
                              if (next === e.display_label) return
                              await updateEntrant(e.id, { display_label: next })
                              await writeAudit(drawing.id, 'entrant.label_changed', {
                                entrant: e.display_name, from: e.display_label, to: next,
                              })
                              await load()
                            }}
                          />
                        ) : (
                          e.display_label
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-ink-500">
                        {e.primary_email ?? e.primary_phone ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular text-ink-600">{t?.payment_count ?? 0}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-600">{formatCents(t?.paid_cents ?? 0)}</td>
                      <td className="px-3 py-2 text-right">
                        {(t?.tickets ?? 0) > 0 ? (
                          <Badge tone="good">{t?.tickets}</Badge>
                        ) : (
                          <span className="text-ink-400">0</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {!editable && (
          <Callout tone="warn" title="Locked">
            The entrant list is frozen. Nothing here can change without unlocking the drawing, which publicly
            retracts the commitment.
          </Callout>
        )}
      </Card>
    </div>
  )
}
