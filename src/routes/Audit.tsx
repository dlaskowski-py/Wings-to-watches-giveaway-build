import { useEffect, useState } from 'react'
import { useDrawing } from './DrawingLayout'
import { listAudit } from '../lib/db'
import type { AuditEntry } from '../lib/types'
import { formatDateTime } from '../lib/format'
import { Card, EmptyState, ErrorBlock, LoadingBlock } from '../components/ui'

/** Human phrasing for the actions the system records. */
const ACTION_LABELS: Record<string, string> = {
  'drawing.created': 'Drawing created',
  'drawing.settings_updated': 'Settings changed',
  'drawing.locked': 'Entrant list locked and commitment published',
  'drawing.unlocked': 'Drawing unlocked — the published commitment was retracted',
  'drawing.drawn': 'Draw executed',
  'drawing.published': 'Results published to the group',
  'import.completed': 'CSV imported',
  'import.reverted': 'Import reverted',
  'entrants.merged': 'Two entrants merged',
  'payment.reviewed': 'Payment reviewed',
  'payments.bulk_reviewed': 'Payments reviewed in bulk',
  'result.status_changed': 'Winner status changed',
}

export function AuditTab() {
  const { drawing } = useDrawing()
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    listAudit(drawing.id).then(setEntries).catch(setError)
  }, [drawing.id])

  return (
    <Card
      title="Audit log"
      description="Append-only. The database blocks edits and deletions, so this record cannot be quietly rewritten — including by you."
    >
      {error ? (
        <ErrorBlock error={error} />
      ) : entries === null ? (
        <LoadingBlock />
      ) : entries.length === 0 ? (
        <EmptyState title="Nothing recorded yet">
          Actions appear here as you import, review, lock and draw.
        </EmptyState>
      ) : (
        <ol className="space-y-3">
          {entries.map((entry) => (
            <li key={entry.id} className="rounded-lg bg-ink-50/60 px-4 py-3 ring-1 ring-ink-100">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-ink-900">
                  {ACTION_LABELS[entry.action] ?? entry.action}
                </p>
                <p className="text-xs text-ink-400">
                  {formatDateTime(entry.created_at)}
                  {entry.actor_email && ` · ${entry.actor_email}`}
                </p>
              </div>
              {Object.keys(entry.detail ?? {}).length > 0 && (
                <pre className="hash mt-2 overflow-x-auto rounded bg-white p-2 text-xs text-ink-600 ring-1 ring-ink-100">
                  {JSON.stringify(entry.detail, null, 2)}
                </pre>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}
