import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { listDrawings } from '../lib/db'
import { DRAWING_STATUS_META, type Drawing } from '../lib/types'
import { formatCents, formatDate, formatRelative } from '../lib/format'
import { Badge, EmptyState, ErrorBlock, LinkButton, LoadingBlock } from '../components/ui'
import { AppShell } from './DrawingLayout'

export function DrawingsPage() {
  const [drawings, setDrawings] = useState<Drawing[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    listDrawings().then(setDrawings).catch(setError)
  }, [])

  return (
    <AppShell>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Drawings</h1>
          <p className="mt-0.5 text-sm text-ink-500">One per quarter. Import payments, verify them, then draw.</p>
        </div>
        <LinkButton to="/new" variant="primary">
          <Plus className="size-4" aria-hidden />
          New drawing
        </LinkButton>
      </div>

      {error ? (
        <ErrorBlock error={error} />
      ) : drawings === null ? (
        <LoadingBlock />
      ) : drawings.length === 0 ? (
        <EmptyState
          title="No drawings yet"
          action={
            <LinkButton to="/new" variant="primary">
              <Plus className="size-4" aria-hidden />
              Create your first drawing
            </LinkButton>
          }
        >
          A drawing holds one quarter’s payments, the frozen entrant list, and the result.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {drawings.map((d) => {
            const meta = DRAWING_STATUS_META[d.status]
            return (
              <li key={d.id}>
                <Link
                  to={`/d/${d.id}`}
                  className="block rounded-xl bg-white p-5 ring-1 ring-ink-200/70 transition hover:ring-brand-300"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-sm font-semibold text-ink-900">{d.name}</h2>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="mt-1 text-sm text-ink-500">
                        {formatCents(d.ticket_price_cents)} per entry · {d.winner_count}{' '}
                        {d.winner_count === 1 ? 'winner' : 'winners'}
                        {d.alternate_count > 0 && ` + ${d.alternate_count} alternates`}
                        {d.window_start && ` · ${formatDate(d.window_start)}–${formatDate(d.window_end)}`}
                      </p>
                    </div>
                    <p className="shrink-0 text-xs text-ink-400">
                      {d.drawn_at ? `Drawn ${formatRelative(d.drawn_at)}` : `Updated ${formatRelative(d.updated_at)}`}
                    </p>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </AppShell>
  )
}
