import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, Download, FileSpreadsheet, Layers, Search, X } from 'lucide-react'
import { useDrawing } from './DrawingLayout'
import { listEntrants, listPayments, updatePayment, updatePaymentsBulk, writeAudit } from '../lib/db'
import { PAYMENT_FLAGS, type PaymentFlag } from '../lib/csv/types'
import type { Entrant, Payment, PaymentStatus } from '../lib/types'
import { formatCents, pluralize } from '../lib/format'
import {
  exportLedgerCsv, exportLedgerXlsx, exportMasterCsv, exportMasterWorkbook, type LedgerRow,
} from '../lib/export'
import {
  Badge, Button, Callout, Card, EmptyState, ErrorBlock, Input, LoadingBlock, Select, Stat,
} from '../components/ui'

type StatusFilter = 'all' | PaymentStatus | 'flagged'
type SortKey = 'date' | 'payer' | 'amount' | 'entries' | 'row'

const STATUS_TONE: Record<PaymentStatus, 'neutral' | 'good' | 'warn' | 'bad'> = {
  needs_review: 'warn',
  approved: 'good',
  excluded: 'neutral',
  duplicate: 'bad',
}

export function ReviewTab() {
  const { drawing, reconciliation, reload, editable } = useDrawing()
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [entrants, setEntrants] = useState<Entrant[]>([])
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [flagFilter, setFlagFilter] = useState<string>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('date')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    try {
      const [p, e] = await Promise.all([listPayments(drawing.id), listEntrants(drawing.id)])
      setPayments(p)
      setEntrants(e)
      setError(null)
    } catch (err) {
      setError(err)
    }
  }, [drawing.id])

  useEffect(() => { void load() }, [load])

  const entrantName = useMemo(() => {
    const map = new Map(entrants.map((e) => [e.id, e.display_name]))
    return (id: string | null) => (id ? (map.get(id) ?? null) : null)
  }, [entrants])

  /** Every flag actually present, with counts, so the operator can work through them. */
  const flagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of payments ?? []) {
      for (const f of p.flags) counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [payments])

  const visible = useMemo(() => {
    let rows = payments ?? []

    if (statusFilter === 'flagged') rows = rows.filter((p) => p.flags.length > 0)
    else if (statusFilter !== 'all') rows = rows.filter((p) => p.status === statusFilter)

    if (flagFilter !== 'all') rows = rows.filter((p) => p.flags.includes(flagFilter))

    const q = search.trim().toLowerCase()
    if (q) {
      rows = rows.filter((p) =>
        [p.raw_payer_name, p.payer_name, p.payer_email, p.payer_handle, p.note, p.external_ref, entrantName(p.entrant_id)]
          .some((v) => v?.toLowerCase().includes(q)),
      )
    }

    const sorted = [...rows]
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'amount': return b.amount_cents - a.amount_cents
        case 'entries': return b.entries - a.entries
        case 'payer':
          return (a.raw_payer_name ?? '').localeCompare(b.raw_payer_name ?? '')
        case 'row': return (a.source_row_number ?? 0) - (b.source_row_number ?? 0)
        case 'date':
        default:
          return (a.paid_on ?? '').localeCompare(b.paid_on ?? '')
      }
    })
    return sorted
  }, [payments, statusFilter, flagFilter, search, sortKey, entrantName])

  const ledgerRows: LedgerRow[] = useMemo(
    () => visible.map((p) => ({ payment: p, entrantName: entrantName(p.entrant_id) })),
    [visible, entrantName],
  )

  async function setStatus(ids: string[], status: PaymentStatus, reason?: string) {
    if (ids.length === 0) return
    setBusy(true)
    try {
      await updatePaymentsBulk(ids, { status, exclude_reason: reason ?? null })
      await writeAudit(drawing.id, ids.length === 1 ? 'payment.reviewed' : 'payments.bulk_reviewed', {
        count: ids.length, status, reason: reason ?? null,
      })
      setSelected(new Set())
      await load()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  async function overrideEntries(payment: Payment, value: string) {
    const trimmed = value.trim()
    const override = trimmed === '' ? null : Math.max(0, Number(trimmed))
    if (trimmed !== '' && !Number.isFinite(override)) return
    setBusy(true)
    try {
      await updatePayment(payment.id, {
        entries_override: override,
        override_reason: override === null ? null : 'Set by hand during review',
      })
      await load()
      await reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (error) return <ErrorBlock error={error} />
  if (payments === null) return <LoadingBlock label="Loading payments…" />

  const r = reconciliation
  const pending = r?.needs_review_count ?? 0
  const allVisibleSelected = visible.length > 0 && visible.every((p) => selected.has(p.id))

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------ reconciliation --- */}
      <Card
        title="Reconciliation"
        description="Tie these numbers out against what actually landed in your account before you lock."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => exportMasterCsv(drawing, payments, entrants)}>
              <Layers className="size-3.5" aria-hidden />
              Master CSV
            </Button>
            <Button size="sm" onClick={() => void exportMasterWorkbook(drawing, payments, entrants)}>
              <FileSpreadsheet className="size-3.5" aria-hidden />
              Master workbook
            </Button>
          </div>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Approved" value={formatCents(r?.approved_cents ?? 0)} hint={`${r?.approved_count ?? 0} payments`} tone="good" />
          <Stat label="Awaiting review" value={formatCents(r?.pending_cents ?? 0)} hint={pluralize(pending, 'payment')} tone={pending > 0 ? 'warn' : 'neutral'} />
          <Stat label="Entries" value={(r?.total_entries ?? 0).toLocaleString()} hint={`${r?.entrant_count ?? 0} entrants`} />
          <Stat label="Unallocated" value={formatCents(r?.unallocated_cents ?? 0)} hint="Not enough for a whole entry" tone={(r?.unallocated_cents ?? 0) > 0 ? 'warn' : 'neutral'} />
        </dl>

        {r && (
          <p className="mt-3 text-sm text-ink-600">
            {formatCents(r.approved_cents)} approved breaks down as{' '}
            <span className="tabular font-medium">{r.total_entries.toLocaleString()}</span> ×{' '}
            {formatCents(drawing.ticket_price_cents)} ={' '}
            <span className="tabular font-medium">{formatCents(r.total_entries * drawing.ticket_price_cents)}</span>
            {r.unallocated_cents > 0 && <>, plus {formatCents(r.unallocated_cents)} that did not reach a whole entry</>}.
            {r.excluded_count > 0 && <> {pluralize(r.excluded_count, 'payment')} excluded ({formatCents(r.excluded_cents)}).</>}
          </p>
        )}

        <p className="mt-3 text-xs text-ink-500">
          The <span className="font-medium">master</span> files cover every payment across Venmo and Zelle,
          one row per person, whatever filters are set below — that is the copy to keep. The workbook adds a
          summary sheet and the full payment ledger. To export just what the table below is showing, use the
          buttons above it.
        </p>

        {pending > 0 && (
          <Callout tone="warn" title={`${pluralize(pending, 'payment')} still needs a decision`}>
            You cannot lock the drawing until every row is approved, excluded, or marked duplicate. That is the
            whole point of this screen — nothing gets counted that you have not looked at.
          </Callout>
        )}
      </Card>

      {/* ---------------------------------------------------- flag queue --- */}
      {flagCounts.length > 0 && (
        <Card title="Flags" description="Click a flag to filter the table to just those rows.">
          <div className="flex flex-wrap gap-2">
            {flagCounts.map(([flag, count]) => (
              <button
                key={flag}
                onClick={() => { setFlagFilter(flagFilter === flag ? 'all' : flag); setStatusFilter('all') }}
                className={
                  'rounded-lg px-3 py-2 text-left text-xs ring-1 transition ' +
                  (flagFilter === flag
                    ? 'bg-brand-50 text-brand-900 ring-brand-300'
                    : 'bg-white text-ink-700 ring-ink-200 hover:bg-ink-50')
                }
              >
                <span className="font-medium">{flag}</span>
                <span className="ml-2 tabular text-ink-400">{count}</span>
                <span className="mt-0.5 block max-w-xs text-ink-500">
                  {PAYMENT_FLAGS[flag as PaymentFlag] ?? 'Flagged during import'}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* -------------------------------------------------------- ledger --- */}
      <Card
        title="Payments"
        description={`${visible.length.toLocaleString()} of ${payments.length.toLocaleString()} shown`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => exportLedgerCsv(drawing, ledgerRows)}>
              <Download className="size-3.5" aria-hidden />
              Export this view (CSV)
            </Button>
            <Button size="sm" onClick={() => void exportLedgerXlsx(drawing, ledgerRows)}>
              <FileSpreadsheet className="size-3.5" aria-hidden />
              Excel
            </Button>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="min-w-48 flex-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-400" aria-hidden />
              <Input
                className="pl-9"
                placeholder="Search payer, note, transaction ID…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} className="w-44">
            <option value="all">All statuses</option>
            <option value="needs_review">Needs review</option>
            <option value="approved">Approved</option>
            <option value="excluded">Excluded</option>
            <option value="duplicate">Duplicates</option>
            <option value="flagged">Anything flagged</option>
          </Select>
          <Select value={flagFilter} onChange={(e) => setFlagFilter(e.target.value)} className="w-52">
            <option value="all">All flags</option>
            {flagCounts.map(([flag, count]) => (
              <option key={flag} value={flag}>{flag} ({count})</option>
            ))}
          </Select>
          <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="w-40">
            <option value="date">Sort by date</option>
            <option value="payer">Sort by payer</option>
            <option value="amount">Sort by amount</option>
            <option value="entries">Sort by entries</option>
            <option value="row">Sort by file row</option>
          </Select>
        </div>

        {editable && selected.size > 0 && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-4 py-2.5 ring-1 ring-brand-200">
            <span className="text-sm font-medium text-brand-900">{pluralize(selected.size, 'row')} selected</span>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void setStatus([...selected], 'approved')}>
              <Check className="size-3.5" aria-hidden />
              Approve
            </Button>
            <Button size="sm" loading={busy} onClick={() => {
              const reason = prompt('Why are these being excluded?') ?? ''
              if (reason.trim()) void setStatus([...selected], 'excluded', reason.trim())
            }}>
              <X className="size-3.5" aria-hidden />
              Exclude
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}

        {visible.length === 0 ? (
          <EmptyState title="No payments match these filters">
            {payments.length === 0 ? 'Import a CSV to get started.' : 'Try clearing the search or filters.'}
          </EmptyState>
        ) : (
          <div className="scroll-x rounded-lg ring-1 ring-ink-200">
            <table className="min-w-full text-sm">
              <thead className="bg-ink-50 text-xs font-semibold uppercase tracking-column text-ink-500">
                <tr>
                  {editable && (
                    <th className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all visible rows"
                        checked={allVisibleSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(visible.map((p) => p.id)) : new Set())
                        }
                      />
                    </th>
                  )}
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Payer</th>
                  <th className="px-3 py-2 text-left font-medium">Entrant</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Entries</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Flags &amp; note</th>
                  {editable && <th className="px-3 py-2 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {visible.map((p) => (
                  <tr key={p.id} className={p.direction === 'out' ? 'bg-ink-50/50' : undefined}>
                    {editable && (
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Select payment from ${p.raw_payer_name ?? 'unknown payer'}`}
                          checked={selected.has(p.id)}
                          onChange={(e) => {
                            const next = new Set(selected)
                            if (e.target.checked) next.add(p.id)
                            else next.delete(p.id)
                            setSelected(next)
                          }}
                        />
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 tabular text-ink-600">{p.paid_on ?? '—'}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-ink-900">{p.raw_payer_name ?? <span className="text-bad-600">no payer</span>}</div>
                      {(p.payer_email || p.payer_handle) && (
                        <div className="text-xs text-ink-400">{p.payer_email ?? p.payer_handle}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-ink-600">{entrantName(p.entrant_id) ?? <span className="text-warn-700">unassigned</span>}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular">
                      {p.direction === 'out' && <span className="mr-1 text-ink-400">out</span>}
                      {formatCents(p.amount_cents)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {editable ? (
                        <input
                          type="number"
                          min={0}
                          aria-label="Entries"
                          className="w-16 rounded border-0 bg-transparent px-1 py-0.5 text-right tabular text-ink-900 ring-1 ring-inset ring-transparent hover:ring-ink-200 focus:bg-white focus:ring-brand-500"
                          defaultValue={p.entries}
                          // Remount when the stored value changes so the input
                          // never shows a stale number after a save.
                          key={`${p.id}-${p.entries}-${p.entries_override ?? 'auto'}`}
                          title={
                            p.entries_override === null
                              ? 'Computed from the amount. Type a number to override it, or clear the box to go back to computed.'
                              : `Set by hand. Clear the box to go back to ${Math.floor(p.amount_cents / drawing.ticket_price_cents)} computed.`
                          }
                          onBlur={(e) => {
                            const next = e.target.value.trim()
                            // Empty means "stop overriding"; anything else is an
                            // explicit count. Skip the write when nothing changed.
                            if (next === '' && p.entries_override === null) return
                            if (next !== '' && Number(next) === p.entries) return
                            void overrideEntries(p, next)
                          }}
                        />
                      ) : (
                        <span className="tabular">{p.entries}</span>
                      )}
                    </td>
                    <td className="px-3 py-2"><Badge tone={STATUS_TONE[p.status]}>{p.status.replace('_', ' ')}</Badge></td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {p.flags.map((f) => (
                          <Badge key={f} tone={f === 'duplicate_suspected' ? 'warn' : 'neutral'} className="max-w-full">
                            <span title={PAYMENT_FLAGS[f as PaymentFlag] ?? f}>{f}</span>
                          </Badge>
                        ))}
                      </div>
                      {p.note && <p className="mt-1 max-w-xs truncate text-xs text-ink-500" title={p.note}>{p.note}</p>}
                      {p.exclude_reason && <p className="mt-1 text-xs text-ink-400">Excluded: {p.exclude_reason}</p>}
                    </td>
                    {editable && (
                      <td className="whitespace-nowrap px-3 py-2 text-right">
                        {p.status !== 'approved' && (
                          <Button size="sm" variant="ghost" onClick={() => void setStatus([p.id], 'approved')}>Approve</Button>
                        )}
                        {p.status !== 'excluded' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              const reason = prompt('Why is this being excluded?') ?? ''
                              if (reason.trim()) void setStatus([p.id], 'excluded', reason.trim())
                            }}
                          >
                            Exclude
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
