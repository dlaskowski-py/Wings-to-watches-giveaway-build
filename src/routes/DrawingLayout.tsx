import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router-dom'
import { clsx } from 'clsx'
import { ArrowLeft, LogOut } from 'lucide-react'
import { getDrawing, getReconciliation } from '../lib/db'
import { DRAWING_STATUS_META, type Drawing, type Reconciliation } from '../lib/types'
import { useAuth } from '../lib/auth'
import { Badge, ErrorBlock, LoadingBlock } from '../components/ui'
import { BrandFooter, Watermark, Wordmark } from '../components/brand'
import { formatCents } from '../lib/format'

/* -------------------------------------------------------------------------- *
 * App shell
 * -------------------------------------------------------------------------- */

export function AppShell({ children }: { children: ReactNode }) {
  const { signOut } = useAuth()
  return (
    <div className="relative flex min-h-screen flex-col">
      <Watermark />
      <header className="relative z-10 border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="text-sm font-semibold text-ink-900">
            Wings to Watches <span className="font-normal text-ink-400">giveaway console</span>
          </Link>
          <div className="flex items-center gap-4">
            <Wordmark size="sm" className="max-sm:hidden" />
            <button
              onClick={() => void signOut()}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-900"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="relative z-10 mx-auto w-full max-w-7xl flex-1 px-6 py-8">{children}</main>
      <BrandFooter className="relative z-10 mt-16" />
    </div>
  )
}

/* -------------------------------------------------------------------------- *
 * Drawing context
 *
 * Every tab needs the drawing and its reconciliation totals, and several of them
 * mutate it. Sharing one loader here keeps the tabs in step and means a change
 * on the review screen is reflected in the header banner immediately.
 * -------------------------------------------------------------------------- */

interface DrawingContextValue {
  drawing: Drawing
  reconciliation: Reconciliation | null
  reload: () => Promise<void>
  /** True while the drawing can still be edited. */
  editable: boolean
}

const DrawingContext = createContext<DrawingContextValue | null>(null)

export function useDrawing(): DrawingContextValue {
  const ctx = useContext(DrawingContext)
  if (!ctx) throw new Error('useDrawing must be used inside <DrawingLayout>')
  return ctx
}

const TABS = [
  { to: '.', label: 'Overview', end: true },
  { to: 'import', label: 'Import' },
  { to: 'review', label: 'Review' },
  { to: 'entrants', label: 'Entrants' },
  { to: 'draw', label: 'Lock & draw' },
  { to: 'audit', label: 'Audit log' },
]

export function DrawingLayout() {
  const { id } = useParams<{ id: string }>()
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null)
  const [error, setError] = useState<unknown>(null)

  const reload = useCallback(async () => {
    if (!id) return
    try {
      const [d, r] = await Promise.all([getDrawing(id), getReconciliation(id)])
      setDrawing(d)
      setReconciliation(r)
      setError(null)
    } catch (err) {
      setError(err)
    }
  }, [id])

  useEffect(() => {
    void reload()
  }, [reload])

  if (error) {
    return (
      <AppShell>
        <ErrorBlock error={error} />
      </AppShell>
    )
  }
  if (!drawing) {
    return (
      <AppShell>
        <LoadingBlock label="Loading drawing…" />
      </AppShell>
    )
  }

  const meta = DRAWING_STATUS_META[drawing.status]
  const editable = drawing.status === 'draft' || drawing.status === 'reviewing'

  return (
    <AppShell>
      <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-500 hover:text-ink-900">
        <ArrowLeft className="size-4" aria-hidden />
        All drawings
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-ink-900">{drawing.name}</h1>
            <Badge tone={meta.tone}>{meta.label}</Badge>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">{meta.blurb}</p>
        </div>
        <dl className="flex shrink-0 gap-6 text-right">
          <div>
            <dt className="text-xs text-ink-400">Entries</dt>
            <dd className="text-sm font-semibold tabular text-ink-900">
              {(reconciliation?.total_entries ?? 0).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-400">Approved</dt>
            <dd className="text-sm font-semibold tabular text-ink-900">
              {formatCents(reconciliation?.approved_cents ?? 0)}
            </dd>
          </div>
          {(reconciliation?.needs_review_count ?? 0) > 0 && (
            <div>
              <dt className="text-xs text-ink-400">To review</dt>
              <dd className="text-sm font-semibold tabular text-warn-700">
                {reconciliation?.needs_review_count}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-ink-200">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              clsx(
                'whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800',
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <DrawingContext.Provider value={{ drawing, reconciliation, reload, editable }}>
        <Outlet />
      </DrawingContext.Provider>
    </AppShell>
  )
}
