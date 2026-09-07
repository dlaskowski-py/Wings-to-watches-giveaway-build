import { useCallback, useEffect, useState } from 'react'
import { Dices, ExternalLink, FileText, Lock, LockOpen, Share2, Trophy } from 'lucide-react'
import { useDrawing } from './DrawingLayout'
import { listDrawResults, listSnapshotEntries, publishDrawing, setResultStatus, unlockDrawing, writeAudit } from '../lib/db'
import { callDrawingAction } from '../lib/supabase'
import type { DrawResultRow, SnapshotEntry } from '../lib/types'
import { formatCountdown, formatDateTime, pluralize } from '../lib/format'
import { exportVerificationRecord } from '../lib/export'
import { drandPublicUrl } from '../lib/draw/beacon'
import {
  Badge, Button, Callout, Card, EmptyState, Field, HashValue, Input, LoadingBlock, Stat,
} from '../components/ui'

export function DrawTab() {
  const { drawing, reconciliation, reload } = useDrawing()
  const [snapshot, setSnapshot] = useState<SnapshotEntry[]>([])
  const [results, setResults] = useState<DrawResultRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmName, setConfirmName] = useState('')
  const [leadMinutes, setLeadMinutes] = useState('60')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, r] = await Promise.all([listSnapshotEntries(drawing.id), listDrawResults(drawing.id)])
      setSnapshot(s)
      setResults(r)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [drawing.id])

  useEffect(() => { void load() }, [load])

  // Drives the countdown to the committed beacon round.
  useEffect(() => {
    if (drawing.status !== 'locked') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [drawing.status])

  const pending = reconciliation?.needs_review_count ?? 0
  const beaconAt = drawing.beacon_expected_at ? new Date(drawing.beacon_expected_at).getTime() : 0
  const beaconReady = beaconAt > 0 && now >= beaconAt
  const verifyUrl = `${window.location.origin}/verify/${drawing.id}`

  async function doLock() {
    setBusy(true)
    setError(null)
    try {
      await callDrawingAction('lock', {
        drawingId: drawing.id,
        beaconLeadSeconds: Math.max(300, Number(leadMinutes) * 60 || 3600),
      })
      setConfirmName('')
      await load()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function doDraw() {
    setBusy(true)
    setError(null)
    try {
      await callDrawingAction('draw', { drawingId: drawing.id })
      await load()
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <LoadingBlock />

  /* ------------------------------------------------------------ reviewing */

  if (drawing.status === 'draft' || drawing.status === 'reviewing') {
    const totalTickets = reconciliation?.total_entries ?? 0
    const canLock = pending === 0 && totalTickets > 0
    return (
      <div className="space-y-6">
        <Card title="Lock the entrant list" description="This freezes who is in the draw and publishes the commitment.">
          <div className="space-y-5">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat label="Entrants" value={(reconciliation?.entrant_count ?? 0).toLocaleString()} />
              <Stat label="Tickets" value={totalTickets.toLocaleString()} />
              <Stat label="Still to review" value={pending.toLocaleString()} tone={pending > 0 ? 'bad' : 'good'} />
            </dl>

            {pending > 0 && (
              <Callout tone="bad" title={`${pluralize(pending, 'payment')} has not been reviewed`}>
                Every row must be approved, excluded or marked duplicate before you can lock. Go to the Review tab
                and clear the queue.
              </Callout>
            )}
            {pending === 0 && totalTickets === 0 && (
              <Callout tone="bad" title="Nobody has any tickets">
                Approve some payments first, or there is nothing to draw from.
              </Callout>
            )}

            <Callout tone="info" title="What locking does">
              <ul className="list-disc space-y-1 pl-4">
                <li>Freezes the entrant list and their ticket counts. Payments and entrants become read-only.</li>
                <li>Publishes a SHA-256 hash of that exact list, so it cannot be swapped later.</li>
                <li>
                  Generates a secret seed that even you cannot read, and publishes its hash. You get the seed only
                  after the draw.
                </li>
                <li>
                  Commits to a <strong>future</strong> drand beacon round. Nobody — including you — can know the
                  outcome until that round is published, which is what makes the result credible to the group.
                </li>
              </ul>
            </Callout>

            <Field
              label="How long before the draw can run?"
              hint="Give yourself enough time to post the commitment to the group before the beacon lands. That gap is the security margin."
            >
              <Input
                type="number"
                min={5}
                max={10080}
                className="max-w-40"
                value={leadMinutes}
                onChange={(e) => setLeadMinutes(e.target.value)}
              />
            </Field>

            <Field
              label={<>Type <span className="font-mono">{drawing.name}</span> to confirm</>}
              hint="Locking is deliberate and hard to undo. Unlocking retracts a commitment the group may already have seen."
            >
              <Input
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                placeholder={drawing.name}
                className="max-w-md"
              />
            </Field>

            {error && <Callout tone="bad">{error}</Callout>}

            <Button
              variant="primary"
              size="lg"
              loading={busy}
              disabled={!canLock || confirmName.trim() !== drawing.name}
              onClick={() => void doLock()}
            >
              <Lock className="size-4" aria-hidden />
              Lock the entrant list
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  /* --------------------------------------------------------------- locked */

  if (drawing.status === 'locked') {
    return (
      <div className="space-y-6">
        <Card
          title="Commitment published"
          description="Share these four values with the group NOW, before the beacon round lands. That is what makes the result verifiable."
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <HashValue label="Entrant list hash" value={drawing.snapshot_hash} />
              <HashValue label="Seed commitment" value={drawing.seed_commitment} />
              <HashValue label="drand chain" value={drawing.beacon_chain} />
              <div>
                <span className="text-xs font-medium text-ink-500">Beacon round</span>
                <p className="hash mt-0.5 text-xs text-ink-800">{drawing.beacon_round}</p>
                <a
                  href={drawing.beacon_round ? drandPublicUrl(drawing.beacon_round) : '#'}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                >
                  Check it on drand
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              </div>
            </div>

            <div className="rounded-lg bg-ink-50 px-4 py-3">
              <p className="text-xs font-medium text-ink-500">Public verification link</p>
              <p className="hash mt-1 text-xs text-brand-700">{verifyUrl}</p>
            </div>

            <Button
              onClick={async () => {
                const text =
                  `${drawing.name} — draw commitment\n\n` +
                  `Entrant list hash: ${drawing.snapshot_hash}\n` +
                  `Seed commitment:   ${drawing.seed_commitment}\n` +
                  `drand round:       ${drawing.beacon_round} (${formatDateTime(drawing.beacon_expected_at)})\n\n` +
                  `Nobody can know the winners until drand round ${drawing.beacon_round} is published.\n` +
                  `Verify at: ${verifyUrl}`
                try {
                  await navigator.clipboard.writeText(text)
                } catch {
                  window.prompt('Copy this and post it to the group:', text)
                }
              }}
            >
              <Share2 className="size-4" aria-hidden />
              Copy the announcement for the group
            </Button>
          </div>
        </Card>

        <Card title="Run the draw">
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat label="Entrants frozen" value={snapshot.length.toLocaleString()} />
              <Stat label="Tickets" value={snapshot.reduce((s, e) => s + e.tickets, 0).toLocaleString()} />
              <Stat
                label={beaconReady ? 'Beacon' : 'Beacon lands in'}
                value={beaconReady ? 'Ready' : formatCountdown(beaconAt - now)}
                tone={beaconReady ? 'good' : 'warn'}
              />
            </dl>

            {!beaconReady && (
              <Callout tone="warn" title="Waiting on the public beacon">
                drand round {drawing.beacon_round} is expected at {formatDateTime(drawing.beacon_expected_at)}.
                Until it is published, its value does not exist yet — which is precisely why the outcome cannot be
                known or influenced in advance. Post the commitment above to the group while you wait.
              </Callout>
            )}

            {error && <Callout tone="bad">{error}</Callout>}

            <Button variant="primary" size="lg" loading={busy} disabled={!beaconReady} onClick={() => void doDraw()}>
              <Dices className="size-4" aria-hidden />
              Draw the winners
            </Button>
          </div>
        </Card>

        <Card title="Need to change something?" description="Only possible before the draw, and it is visible.">
          <Callout tone="warn" title="Unlocking retracts the published commitment">
            If you found a mistake in the payments, you can unlock, fix it, and lock again — but the group may
            already have seen the old hash, and it will change. The reason you give is written to the audit log.
          </Callout>
          <Button
            className="mt-3"
            variant="danger"
            loading={busy}
            onClick={async () => {
              const reason = prompt('Why are you unlocking? This is recorded permanently and the commitment is retracted.') ?? ''
              if (reason.trim().length < 5) return
              setBusy(true)
              try {
                await unlockDrawing(drawing.id, reason.trim())
                await load()
                await reload()
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              } finally {
                setBusy(false)
              }
            }}
          >
            <LockOpen className="size-4" aria-hidden />
            Unlock and go back to review
          </Button>
        </Card>
      </div>
    )
  }

  /* ------------------------------------------------------- drawn/published */

  const winners = results.filter((r) => !r.is_alternate)
  const alternates = results.filter((r) => r.is_alternate)

  return (
    <div className="space-y-6">
      <Card
        title="Winners"
        description={`Drawn ${formatDateTime(drawing.drawn_at)} from ${pluralize(snapshot.length, 'entrant')} holding ${pluralize(snapshot.reduce((s, e) => s + e.tickets, 0), 'ticket')}.`}
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => exportVerificationRecord(drawing, snapshot, results)}>
              <FileText className="size-3.5" aria-hidden />
              Verification record
            </Button>
            {drawing.status === 'drawn' && (
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await publishDrawing(drawing.id)
                    await writeAudit(drawing.id, 'drawing.published', {})
                    await reload()
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Mark as published
              </Button>
            )}
          </div>
        }
      >
        {results.length === 0 ? (
          <EmptyState title="No results recorded" />
        ) : (
          <>
            <ol className="space-y-2">
              {winners.map((w) => (
                <li
                  key={w.rank}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-emerald-50 px-4 py-3 ring-1 ring-emerald-200"
                >
                  <div className="flex items-center gap-3">
                    <Trophy className="size-5 text-emerald-600" aria-hidden />
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">
                        #{w.rank} — {w.display_label}
                      </p>
                      <p className="text-xs text-emerald-700">
                        held {pluralize(w.tickets, 'ticket')}
                        {w.status && w.status !== 'active' ? ` · ${w.status}` : ''}
                      </p>
                    </div>
                  </div>
                  {w.status === 'active' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const note = prompt('Why is this winner forfeiting? The next alternate is promoted.') ?? ''
                        if (!note.trim()) return
                        await setResultStatus(drawing.id, w.rank, 'forfeited', note.trim())
                        const next = alternates.find((a) => a.status === 'active')
                        if (next) await setResultStatus(drawing.id, next.rank, 'promoted', `Promoted after rank ${w.rank} forfeited`)
                        await writeAudit(drawing.id, 'result.status_changed', { rank: w.rank, status: 'forfeited', note: note.trim() })
                        await load()
                      }}
                    >
                      Mark forfeited
                    </Button>
                  )}
                </li>
              ))}
            </ol>

            {alternates.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">Alternates, in order</h3>
                <ol className="space-y-1">
                  {alternates.map((a) => (
                    <li key={a.rank} className="flex items-center justify-between rounded-lg bg-ink-50 px-4 py-2 text-sm">
                      <span className="text-ink-700">#{a.rank} — {a.display_label}</span>
                      <span className="flex items-center gap-2 text-xs text-ink-500">
                        {pluralize(a.tickets, 'ticket')}
                        {a.status === 'promoted' ? <Badge tone="good">promoted</Badge> : null}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="Proof" description="Everything anyone needs to check this result themselves.">
        <div className="grid gap-4 sm:grid-cols-2">
          <HashValue label="Entrant list hash" value={drawing.snapshot_hash} />
          <HashValue label="Seed commitment" value={drawing.seed_commitment} />
          <HashValue label="Revealed seed" value={drawing.revealed_seed} />
          <HashValue label="Final seed" value={drawing.final_seed} />
          <HashValue label="Beacon randomness" value={drawing.beacon_randomness} />
          <div>
            <span className="text-xs font-medium text-ink-500">drand round</span>
            <p className="hash mt-0.5 text-xs text-ink-800">{drawing.beacon_round}</p>
            <a
              href={drawing.beacon_round ? drandPublicUrl(drawing.beacon_round) : '#'}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
            >
              Check it on drand
              <ExternalLink className="size-3" aria-hidden />
            </a>
          </div>
        </div>

        <div className="mt-4 rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-brand-200">
          <p className="text-sm font-medium text-brand-900">Share this link with the group</p>
          <p className="hash mt-1 text-xs text-brand-700">{verifyUrl}</p>
          <p className="mt-2 text-xs text-brand-800">
            It re-runs the draw in their own browser from the values above and shows them, check by check, whether
            it holds up. They do not need an account, and they never see anybody's payment details.
          </p>
        </div>
      </Card>
    </div>
  )
}
