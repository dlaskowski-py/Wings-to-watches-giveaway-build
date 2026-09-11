import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CheckCircle2, ExternalLink, ShieldCheck, XCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import {
  DRAW_PROTOCOL_VERSION, verifyDraw,
  type DrawResult, type DrawSnapshot, type VerificationReport,
} from '../lib/draw/core'
import { DRAND_CHAIN_QUICKNET, drandPublicUrl, fetchRoundCorroborated } from '../lib/draw/beacon'
import { formatDateTime, formatOdds, pluralize } from '../lib/format'
import { Badge, Button, Callout, Card, LoadingBlock, Spinner } from '../components/ui'
import { BrandFooter, Wordmark } from '../components/brand'

/**
 * The public verification page.
 *
 * Deliberately outside the authenticated console: a group member checking
 * whether the draw was honest must never be asked to sign in, or "anyone can
 * verify this" would not be true.
 *
 * Everything here is fetched with the publishable key and is governed by RLS,
 * which exposes only the commitment values, the frozen entrant list (public id,
 * a low-disclosure label like "Daniel L.", and a ticket count) and the results.
 * No emails, phone numbers, real names or payment amounts are reachable.
 *
 * The recomputation runs in the visitor's OWN browser using the same code the
 * Edge Function ran — see the note at the top of lib/draw/core.ts.
 */

interface PublicDrawing {
  id: string
  name: string
  status: string
  ticket_price_cents: number
  winner_count: number
  alternate_count: number
  prize_description: string | null
  snapshot_hash: string | null
  seed_commitment: string | null
  beacon_chain: string | null
  beacon_round: number | null
  beacon_expected_at: string | null
  beacon_randomness: string | null
  final_seed: string | null
  revealed_seed: string | null
  locked_at: string | null
  drawn_at: string | null
}

interface PublicEntry { public_id: string; display_label: string; tickets: number }
interface PublicResult { rank: number; public_id: string; display_label: string; tickets: number; is_alternate: boolean; status: string }

export function VerifyPage() {
  const { id } = useParams<{ id: string }>()
  const [drawing, setDrawing] = useState<PublicDrawing | null>(null)
  const [entries, setEntries] = useState<PublicEntry[]>([])
  const [results, setResults] = useState<PublicResult[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [report, setReport] = useState<VerificationReport | null>(null)
  const [beaconOk, setBeaconOk] = useState<boolean | null>(null)
  const [beaconSources, setBeaconSources] = useState(0)
  const [verifying, setVerifying] = useState(false)
  const [showList, setShowList] = useState(false)

  useEffect(() => {
    if (!id) return
    let active = true
    ;(async () => {
      try {
        const [d, e, r] = await Promise.all([
          supabase
            .from('drawings')
            .select(
              'id,name,status,ticket_price_cents,winner_count,alternate_count,prize_description,snapshot_hash,seed_commitment,beacon_chain,beacon_round,beacon_expected_at,beacon_randomness,final_seed,revealed_seed,locked_at,drawn_at',
            )
            .eq('id', id)
            .maybeSingle(),
          supabase.from('draw_snapshot_entries').select('public_id,display_label,tickets').eq('drawing_id', id).order('public_id'),
          supabase.from('draw_results').select('rank,public_id,display_label,tickets,is_alternate,status').eq('drawing_id', id).order('rank'),
        ])
        if (!active) return
        if (d.error) throw new Error(d.error.message)
        if (!d.data) throw new Error('That drawing does not exist, or has not been locked yet.')
        setDrawing(d.data as PublicDrawing)
        setEntries((e.data ?? []) as PublicEntry[])
        setResults((r.data ?? []) as PublicResult[])
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [id])

  const runVerification = useCallback(async () => {
    if (!drawing || !drawing.revealed_seed) return
    setVerifying(true)
    try {
      const snapshot: DrawSnapshot = {
        protocolVersion: DRAW_PROTOCOL_VERSION,
        drawingId: drawing.id,
        drawingName: drawing.name,
        ticketPriceCents: drawing.ticket_price_cents,
        winnerCount: drawing.winner_count,
        alternateCount: drawing.alternate_count,
        entrants: entries.map((e) => ({
          publicId: e.public_id, displayLabel: e.display_label, tickets: e.tickets,
        })),
      }
      const published: DrawResult = {
        protocolVersion: DRAW_PROTOCOL_VERSION,
        snapshotHash: drawing.snapshot_hash ?? '',
        seedCommitment: drawing.seed_commitment ?? '',
        beacon: {
          chain: drawing.beacon_chain ?? '',
          round: drawing.beacon_round ?? 0,
          randomness: drawing.beacon_randomness ?? '',
        },
        finalSeed: drawing.final_seed ?? '',
        totalTickets: entries.reduce((s, e) => s + e.tickets, 0),
        totalEntrants: entries.length,
        winners: results.map((r) => ({
          rank: r.rank, publicId: r.public_id, displayLabel: r.display_label,
          tickets: r.tickets, isAlternate: r.is_alternate,
        })),
        randomWordsConsumed: 0,
      }

      // Independently re-fetch the beacon from drand rather than trusting the
      // value stored here. This is what catches a fabricated beacon.
      let beaconMatches: boolean | null = null
      try {
        // Two independent mirrors must agree before this counts as confirmed.
        const live = await fetchRoundCorroborated(drawing.beacon_round ?? 0)
        beaconMatches = live.randomness === drawing.beacon_randomness
        setBeaconSources(live.sources.length)
      } catch {
        beaconMatches = null
      }
      setBeaconOk(beaconMatches)

      setReport(await verifyDraw(snapshot, published, drawing.revealed_seed))
    } finally {
      setVerifying(false)
    }
  }, [drawing, entries, results])

  if (loading) return <PublicShell><LoadingBlock /></PublicShell>
  if (error || !drawing) {
    return (
      <PublicShell>
        <Callout tone="bad" title="Cannot show this drawing">{error ?? 'Unknown error'}</Callout>
      </PublicShell>
    )
  }

  const totalTickets = entries.reduce((s, e) => s + e.tickets, 0)
  const drawn = drawing.status === 'drawn' || drawing.status === 'published'
  const winners = results.filter((r) => !r.is_alternate)
  const alternates = results.filter((r) => r.is_alternate)

  return (
    <PublicShell>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-ink-900">{drawing.name}</h1>
        <p className="mt-1 text-sm text-ink-500">
          {drawn
            ? `Drawn ${formatDateTime(drawing.drawn_at)}. Anyone can check this result — including you, right now, in this browser.`
            : `Entrant list locked ${formatDateTime(drawing.locked_at)}. The draw has not happened yet.`}
        </p>
        {drawing.prize_description && <p className="mt-2 text-sm text-ink-700">{drawing.prize_description}</p>}
      </div>

      {/* ------------------------------------------------------- results --- */}
      {drawn && (
        <Card title="Result" className="mb-6">
          <ol className="space-y-2">
            {winners.map((w) => (
              <li key={w.rank} className="rounded-lg bg-good-50 px-4 py-3 ring-1 ring-good-200">
                <p className="text-sm font-semibold text-good-900">#{w.rank} — {w.display_label}</p>
                <p className="text-xs text-good-700">
                  held {pluralize(w.tickets, 'ticket')} of {totalTickets.toLocaleString()}
                  {' '}({formatOdds(w.tickets, totalTickets)})
                  {w.status && w.status !== 'active' ? ` · ${w.status}` : ''}
                </p>
              </li>
            ))}
          </ol>
          {alternates.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-label text-ink-500">
                Alternates, drawn in the same pass
              </h3>
              <ol className="space-y-1">
                {alternates.map((a) => (
                  <li key={a.rank} className="flex items-center justify-between rounded bg-ink-50 px-3 py-1.5 text-sm">
                    <span className="text-ink-700">#{a.rank} — {a.display_label}</span>
                    <span className="text-xs text-ink-500">
                      {pluralize(a.tickets, 'ticket')}
                      {a.status === 'promoted' ? ' · promoted' : ''}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-ink-500">
                Publishing alternates up front means an unreachable winner is replaced from a list you have already
                seen, rather than by a fresh private draw nobody can check.
              </p>
            </div>
          )}
        </Card>
      )}

      {/* -------------------------------------------------- verification --- */}
      <Card
        title="Check it yourself"
        description="This re-runs the entire draw in your browser from the published values. It does not ask our server who won."
        className="mb-6"
      >
        {!drawn ? (
          <Callout tone="info" title="Not drawn yet">
            The entrant list is frozen and its hash is published below. The winners depend on drand round{' '}
            <span className="hash">{drawing.beacon_round}</span>, which is expected at{' '}
            {formatDateTime(drawing.beacon_expected_at)}. Until then the value does not exist, so nobody — the
            organizer included — can know or influence the outcome.
          </Callout>
        ) : (
          <div className="space-y-4">
            <Button variant="primary" onClick={() => void runVerification()} loading={verifying}>
              <ShieldCheck className="size-4" aria-hidden />
              Re-run the draw and check
            </Button>

            {verifying && <p className="flex items-center gap-2 text-sm text-ink-500"><Spinner /> Recomputing…</p>}

            {report && (
              <>
                <Callout tone={report.valid ? 'good' : 'bad'} title={report.valid ? 'This draw checks out' : 'Verification FAILED'}>
                  {report.valid
                    ? 'Every published value is internally consistent and the winners reproduce exactly. The result could not have been altered after the entrant list was locked.'
                    : 'At least one check did not pass. The published result does not match what the published inputs produce.'}
                </Callout>

                <ul className="space-y-2">
                  {report.checks.map((check) => (
                    <li key={check.id} className="flex gap-3 rounded-lg bg-ink-50 px-4 py-3">
                      {check.passed ? (
                        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good-600" aria-hidden />
                      ) : (
                        <XCircle className="mt-0.5 size-4 shrink-0 text-bad-600" aria-hidden />
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-ink-900">{check.label}</p>
                        <p className="hash mt-0.5 text-xs text-ink-500">{check.detail}</p>
                      </div>
                    </li>
                  ))}

                  <li className="flex gap-3 rounded-lg bg-ink-50 px-4 py-3">
                    {beaconOk === true ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-good-600" aria-hidden />
                    ) : beaconOk === false ? (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-bad-600" aria-hidden />
                    ) : (
                      <span className="mt-0.5 size-4 shrink-0 rounded-full bg-ink-300" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink-900">
                        Beacon value matches the live drand network
                      </p>
                      <p className="text-xs text-ink-500">
                        {beaconOk === true
                          ? `Round ${drawing.beacon_round} fetched directly from ${beaconSources > 1 ? `${beaconSources} independent drand mirrors` : 'drand'} matches the value used here, so it was not fabricated.`
                          : beaconOk === false
                            ? 'The stored beacon value does NOT match what drand publishes for that round.'
                            : 'Could not reach drand from your browser. Open the link below to check by hand.'}
                      </p>
                    </div>
                  </li>
                </ul>
              </>
            )}
          </div>
        )}
      </Card>

      {/* ------------------------------------------------- published data --- */}
      <Card title="The published values" className="mb-6">
        <dl className="space-y-3 text-sm">
          <Row label="Entrant list hash (SHA-256)" value={drawing.snapshot_hash} />
          <Row label="Seed commitment (SHA-256 of the secret seed)" value={drawing.seed_commitment} />
          <Row label="drand chain" value={drawing.beacon_chain} />
          <Row label="drand round" value={drawing.beacon_round ? String(drawing.beacon_round) : null} />
          {drawn && <Row label="Beacon randomness" value={drawing.beacon_randomness} />}
          {drawn && <Row label="Revealed seed" value={drawing.revealed_seed} />}
          {drawn && <Row label="Final seed" value={drawing.final_seed} />}
        </dl>

        {drawing.beacon_round && (
          <a
            href={drandPublicUrl(drawing.beacon_round)}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:underline"
          >
            See drand round {drawing.beacon_round} for yourself
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
        )}
      </Card>

      {/* --------------------------------------------------- entrant list --- */}
      <Card
        title="The frozen entrant list"
        description={`${pluralize(entries.length, 'entrant')} holding ${pluralize(totalTickets, 'ticket')}. Find your row and check your ticket count.`}
        actions={
          <Button size="sm" onClick={() => setShowList((v) => !v)}>
            {showList ? 'Hide' : 'Show'} the list
          </Button>
        }
      >
        <p className="text-sm text-ink-600">
          This exact list — every id, ticket count and label below, in this order — is what hashes to{' '}
          <span className="hash text-xs">{drawing.snapshot_hash}</span>. Changing a single ticket would change
          that hash, and the hash was published before the draw.
        </p>

        {showList && (
          <div className="scroll-x mt-4 max-h-96 overflow-y-auto rounded-lg ring-1 ring-ink-200">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 bg-ink-50 text-xs font-semibold uppercase tracking-column text-ink-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Entrant</th>
                  <th className="px-3 py-2 text-left font-medium">Public id</th>
                  <th className="px-3 py-2 text-right font-medium">Tickets</th>
                  <th className="px-3 py-2 text-right font-medium">Chance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {entries.map((e) => {
                  const won = results.find((r) => r.public_id === e.public_id)
                  return (
                    <tr key={e.public_id} className={won && !won.is_alternate ? 'bg-good-50' : undefined}>
                      <td className="px-3 py-2 font-medium text-ink-800">
                        {e.display_label}
                        {won && <Badge tone={won.is_alternate ? 'neutral' : 'good'} className="ml-2">#{won.rank}</Badge>}
                      </td>
                      <td className="hash px-3 py-2 text-xs text-ink-400">{e.public_id}</td>
                      <td className="px-3 py-2 text-right tabular">{e.tickets}</td>
                      <td className="px-3 py-2 text-right tabular text-ink-500">
                        {((e.tickets / Math.max(1, totalTickets)) * 100).toFixed(1)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="How this works">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-700">
          <li>
            <strong>Before the draw</strong>, the entrant list was frozen and its SHA-256 hash published, along
            with the hash of a secret seed the organizer could not read, and the number of a drand beacon round
            that had not happened yet.
          </li>
          <li>
            <strong>drand</strong> is a public randomness network run by Cloudflare, EPFL, Protocol Labs and
            others. It publishes an unpredictable random value every three seconds, and past values stay public
            forever.
          </li>
          <li>
            <strong>After that round was published</strong>, the winners were computed from the entrant list, the
            secret seed and the beacon value together — then the seed was revealed.
          </li>
          <li>
            <strong>Why the organizer could not cheat:</strong> committing to a seed alone would not be enough,
            because they could generate thousands of seeds privately and publish only the one where their friend
            wins. Mixing in a beacon value that did not exist when they committed removes that option entirely.
          </li>
          <li>
            <strong>Weighting:</strong> each ${(drawing.ticket_price_cents / 100).toFixed(2)} entry is one ticket,
            so four tickets is exactly four times the chance of one. Once someone wins, all of their tickets leave
            the pool, so nobody can win twice.
          </li>
        </ol>
      </Card>
    </PublicShell>
  )
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <div>
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd className="hash mt-0.5 text-xs text-ink-800">{value}</dd>
    </div>
  )
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-3">
          <p className="text-sm font-semibold text-ink-900">
            Wings to Watches <span className="font-normal text-ink-400">draw verification</span>
          </p>
          <Wordmark size="sm" className="max-sm:hidden" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-8">{children}</main>
      <div className="mx-auto max-w-3xl px-6 pb-8 text-xs text-ink-400">
        <p>
          This page reads only public verification data: the commitment values, the frozen entrant list, and the
          result. Payment amounts, emails and phone numbers are not accessible here.
        </p>
        <p className="mt-1">drand chain <span className="hash">{DRAND_CHAIN_QUICKNET}</span></p>
      </div>
      <BrandFooter  />
    </div>
  )
}
