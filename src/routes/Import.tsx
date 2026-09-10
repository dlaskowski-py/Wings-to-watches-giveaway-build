import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Papa from 'papaparse'
import { AlertTriangle, ArrowRight, CheckCircle2, Upload } from 'lucide-react'
import { useDrawing } from './DrawingLayout'
import { detectLayout, headerSignature, type Grid } from '../lib/csv/detect'
import { COLUMN_ROLE_LABELS, type ColumnMapping, type ColumnRole, type ImportPreview } from '../lib/csv/types'
import { markDuplicates, normalizeRows } from '../lib/csv/normalize'
import { buildAliases, normalizeName, toDisplayLabel } from '../lib/csv/identity'
import { sha256Hex } from '../lib/draw/core'
import {
  createBatch, createEntrant, existingDedupeHashes, existingOccurrences, insertAliases,
  insertPayments, listAliases, listEntrants, writeAudit,
} from '../lib/db'
import { formatCents, pluralize } from '../lib/format'
import type { EntrantAlias } from '../lib/types'
import { Badge, Button, Callout, Card, Field, Select, Stat } from '../components/ui'

const ROLE_ORDER: ColumnRole[] = [
  'date', 'amount', 'credit', 'debit', 'payer_name', 'description',
  'payer_email', 'payer_phone', 'payer_handle', 'note', 'external_ref', 'status', 'type',
]

type Step = 'upload' | 'map' | 'done'

export function ImportTab() {
  const { drawing, reload, editable } = useDrawing()
  const navigate = useNavigate()
  const fileInput = useRef<HTMLInputElement>(null)

  const [step, setStep] = useState<Step>('upload')
  const [fileName, setFileName] = useState('')
  const [fileSize, setFileSize] = useState(0)
  const [fileHash, setFileHash] = useState('')
  const [grid, setGrid] = useState<Grid>([])
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)
  const [confidence, setConfidence] = useState(0)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [duplicateCount, setDuplicateCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ imported: number; duplicates: number; entrants: number } | null>(null)

  const headers = useMemo(() => {
    if (!mapping) return []
    return (grid[mapping.headerRowIndex] ?? []).map((h) => h.trim())
  }, [grid, mapping])

  const dataRows = useMemo(() => {
    if (!mapping) return []
    return grid.slice(mapping.headerRowIndex + 1).filter((r) => r.some((c) => c.trim() !== ''))
  }, [grid, mapping])

  /* ---------------------------------------------------------------- upload */

  const handleFile = useCallback(
    async (file: File) => {
      setError(null)
      setBusy(true)
      try {
        const text = await file.text()
        if (text.trim() === '') throw new Error('That file is empty.')

        const parsed = Papa.parse<string[]>(text, { skipEmptyLines: false })
        const rows = (parsed.data ?? []) as Grid
        if (rows.length === 0) throw new Error('Could not read any rows from that file.')

        const detection = detectLayout(rows)
        setFileName(file.name)
        setFileSize(file.size)
        setFileHash(await sha256Hex(text))
        setGrid(rows)
        setMapping(detection.mapping)
        setConfidence(detection.confidence)
        setStep('map')
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  /* ------------------------------------------------------------- dry run */

  const runPreview = useCallback(async () => {
    if (!mapping) return
    setBusy(true)
    setError(null)
    try {
      const result = await normalizeRows(headers, dataRows, {
        mapping,
        ticketPriceCents: drawing.ticket_price_cents,
        windowStart: drawing.window_start,
        windowEnd: drawing.window_end,
      })
      const existing = await existingDedupeHashes(drawing.id)
      const marked = markDuplicates(result.rows, existing)
      setPreview({ ...result, rows: marked.rows })
      setDuplicateCount(marked.duplicateCount)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [mapping, headers, dataRows, drawing])

  /* -------------------------------------------------------------- commit */

  async function commitImport() {
    if (!mapping || !preview) return
    setBusy(true)
    setError(null)
    try {
      const batch = await createBatch({
        drawing_id: drawing.id,
        source: mapping.source,
        file_name: fileName,
        file_size_bytes: fileSize,
        file_sha256: fileHash,
        column_mapping: mapping as unknown,
        row_count: preview.totals.rowCount,
        imported_count: preview.rows.length,
        duplicate_count: duplicateCount,
        skipped_count: preview.rejected.length,
      })

      // Resolve each payment to an entrant. Existing aliases decide it; a payer
      // we have never seen creates a new entrant. Only EXACT normalised matches
      // auto-merge — anything fuzzier becomes a suggestion on the Entrants tab.
      const [entrants, aliases, occurrences] = await Promise.all([
        listEntrants(drawing.id),
        listAliases(drawing.id),
        // Highest occurrence already stored per dedupe hash. The unique key is
        // (drawing_id, dedupe_hash, occurrence), so duplicates have to count
        // upward — a flat 1 makes the THIRD identical payment collide and take
        // the whole import down with it.
        existingOccurrences(drawing.id),
      ])
      const nextOccurrence = new Map(occurrences)
      const aliasIndex = new Map(aliases.map((a) => [`${a.kind}:${a.value_norm}`, a.entrant_id]))
      const entrantByName = new Map(entrants.map((e) => [normalizeName(e.display_name), e.id]))

      let entrantsCreated = 0
      const newAliases: Array<Partial<EntrantAlias>> = []

      // Allocates the next free occurrence for a hash, remembering what it
      // handed out so several identical rows in ONE file also count upward.
      const occurrence = (hash: string): number => {
        const previous = nextOccurrence.get(hash)
        const next = previous === undefined ? 0 : previous + 1
        nextOccurrence.set(hash, next)
        return next
      }

      const paymentRows = []
      for (const row of preview.rows) {
        const candidates = buildAliases({
          name: row.rawPayerName, email: row.payerEmail,
          phone: row.payerPhone, handle: row.payerHandle,
        })

        let entrantId: string | null = null
        for (const alias of candidates) {
          const hit = aliasIndex.get(`${alias.kind}:${alias.norm}`)
          if (hit) { entrantId = hit; break }
        }
        if (!entrantId && row.rawPayerName) {
          entrantId = entrantByName.get(normalizeName(row.rawPayerName)) ?? null
        }

        if (!entrantId && candidates.length > 0) {
          const displayName = row.rawPayerName?.trim() || row.payerEmail || row.payerHandle || 'Unknown payer'
          const created = await createEntrant({
            drawing_id: drawing.id,
            display_name: displayName,
            display_label: toDisplayLabel(displayName),
            primary_email: row.payerEmail,
            primary_phone: row.payerPhone,
          })
          entrantId = created.id
          entrantsCreated += 1
          entrantByName.set(normalizeName(displayName), created.id)
        }

        if (entrantId) {
          for (const alias of candidates) {
            const key = `${alias.kind}:${alias.norm}`
            if (!aliasIndex.has(key)) {
              aliasIndex.set(key, entrantId)
              newAliases.push({
                drawing_id: drawing.id, entrant_id: entrantId,
                kind: alias.kind, value_raw: alias.raw, value_norm: alias.norm,
              })
            }
          }
        }

        paymentRows.push({
          drawing_id: drawing.id,
          batch_id: batch.id,
          entrant_id: entrantId,
          source: mapping.source,
          raw_payer_name: row.rawPayerName,
          payer_name: row.payerName,
          payer_email: row.payerEmail,
          payer_phone: row.payerPhone,
          payer_handle: row.payerHandle,
          paid_at: row.paidAt,
          paid_on: row.paidOn,
          amount_cents: row.amountCents,
          direction: row.direction,
          note: row.note,
          external_ref: row.externalRef,
          raw_row: row.rawRow,
          source_row_number: row.sourceRowNumber,
          // Duplicates and outgoing money are parked, never counted, until the
          // operator says otherwise.
          status: row.flags.includes('duplicate_suspected') ? 'duplicate' : 'needs_review',
          flags: row.flags,
          dedupe_hash: row.dedupeHash,
          occurrence: occurrence(row.dedupeHash),
        })
      }

      await insertAliases(newAliases)
      await insertPayments(paymentRows as never)
      await writeAudit(drawing.id, 'import.completed', {
        file_name: fileName, file_sha256: fileHash, source: mapping.source,
        imported: paymentRows.length, duplicates: duplicateCount, skipped: preview.rejected.length,
        entrants_created: entrantsCreated,
      })

      setResult({ imported: paymentRows.length, duplicates: duplicateCount, entrants: entrantsCreated })
      setStep('done')
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!editable) {
    return (
      <Callout tone="warn" title="This drawing is locked">
        You cannot import while the entrant list is frozen. Unlock it from the Lock &amp; draw tab first —
        that publicly retracts the commitment, so only do it if a correction is genuinely needed.
      </Callout>
    )
  }

  /* ------------------------------------------------------------------ UI */

  if (step === 'done' && result) {
    return (
      <Card title="Import complete">
        <div className="space-y-4">
          <Callout tone="good" title={`${pluralize(result.imported, 'payment')} imported`}>
            {result.entrants > 0 && <>{pluralize(result.entrants, 'new entrant')} created. </>}
            {result.duplicates > 0 && (
              <>
                {pluralize(result.duplicates, 'row')} looked identical to something already imported and{' '}
                {result.duplicates === 1 ? 'was' : 'were'} parked as duplicates — they earn no entries until you
                confirm them.{' '}
              </>
            )}
            Nothing counts toward the draw until you approve it on the Review tab.
          </Callout>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => navigate('../review')}>
              Review the payments
              <ArrowRight className="size-4" aria-hidden />
            </Button>
            <Button
              onClick={() => {
                setStep('upload'); setPreview(null); setResult(null); setMapping(null); setGrid([])
              }}
            >
              Import another file
            </Button>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card
        title="1. Upload a CSV"
        description="Venmo's statement export, or a Zelle/checking export from your bank. Any layout works — you confirm the columns next."
      >
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const file = e.dataTransfer.files[0]
            if (file) void handleFile(file)
          }}
          className="rounded-xl border-2 border-dashed border-ink-200 px-6 py-10 text-center"
        >
          <Upload className="mx-auto size-6 text-ink-300" aria-hidden />
          <p className="mt-3 text-sm font-medium text-ink-800">
            {fileName || 'Drop a CSV here, or choose a file'}
          </p>
          <p className="mt-1 text-xs text-ink-500">Nothing is saved until you confirm the summary below.</p>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleFile(file)
            }}
          />
          <Button className="mt-4" onClick={() => fileInput.current?.click()} loading={busy && step === 'upload'}>
            Choose file
          </Button>
        </div>
        {error && step === 'upload' && <Callout tone="bad" title="Could not read that file">{error}</Callout>}
      </Card>

      {mapping && (
        <Card
          title="2. Check the columns"
          description="We guessed these from the header names and the values underneath. Correct anything that looks wrong."
          actions={
            <Badge tone={confidence > 0.75 ? 'good' : confidence > 0.5 ? 'warn' : 'bad'}>
              {confidence > 0.75 ? 'Confident' : confidence > 0.5 ? 'Partly sure' : 'Please check carefully'}
            </Badge>
          }
        >
          <div className="space-y-5">
            {confidence <= 0.75 && (
              <Callout tone="warn" title="Have a close look at this one">
                Some columns could not be identified with confidence. The preview below shows exactly how each row
                will be read — check a few before importing.
              </Callout>
            )}

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Source">
                <Select
                  value={mapping.source}
                  onChange={(e) => setMapping({ ...mapping, source: e.target.value as ColumnMapping['source'] })}
                >
                  <option value="venmo">Venmo</option>
                  <option value="zelle">Zelle</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Header row">
                <Select
                  value={String(mapping.headerRowIndex)}
                  onChange={(e) => setMapping({ ...mapping, headerRowIndex: Number(e.target.value) })}
                >
                  {grid.slice(0, 30).map((row, i) => (
                    <option key={i} value={i}>
                      Row {i + 1}: {row.filter(Boolean).slice(0, 4).join(', ').slice(0, 50) || '(blank)'}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date order" hint="Only matters for ambiguous dates like 03/04.">
                <Select
                  value={mapping.dateOrder}
                  onChange={(e) => setMapping({ ...mapping, dateOrder: e.target.value as ColumnMapping['dateOrder'] })}
                >
                  <option value="auto">Auto-detect (US month first)</option>
                  <option value="mdy">Month / Day / Year</option>
                  <option value="dmy">Day / Month / Year</option>
                  <option value="ymd">Year / Month / Day</option>
                </Select>
              </Field>
              <Field label="Money in vs money out">
                <Select
                  value={mapping.directionMode}
                  onChange={(e) =>
                    setMapping({ ...mapping, directionMode: e.target.value as ColumnMapping['directionMode'] })
                  }
                >
                  <option value="sign">One amount column, minus means outgoing</option>
                  <option value="credit_debit">Separate credit and debit columns</option>
                  <option value="type_column">A type/status column says which</option>
                  <option value="all_incoming">Everything is money in</option>
                </Select>
              </Field>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-ink-800">Column roles</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ROLE_ORDER.map((role) => (
                  <Field key={role} label={COLUMN_ROLE_LABELS[role]}>
                    <Select
                      value={mapping.roles[role] === undefined ? '' : String(mapping.roles[role])}
                      onChange={(e) => {
                        const next = { ...mapping.roles }
                        if (e.target.value === '') delete next[role]
                        else next[role] = Number(e.target.value)
                        setMapping({ ...mapping, roles: next })
                        setPreview(null)
                      }}
                    >
                      <option value="">— not in this file —</option>
                      {headers.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Column ${i + 1}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
            </div>

            <Button variant="primary" onClick={() => void runPreview()} loading={busy}>
              Preview what will be imported
            </Button>
            {error && step === 'map' && <Callout tone="bad">{error}</Callout>}
          </div>
        </Card>
      )}

      {preview && mapping && (
        <Card
          title="3. Confirm"
          description="This is exactly what will be saved. Nothing has been written yet."
        >
          <div className="space-y-5">
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Rows in file" value={preview.totals.rowCount.toLocaleString()} />
              <Stat label="Payments found" value={preview.rows.length.toLocaleString()} hint={`${preview.rejected.length} unreadable rows skipped`} />
              <Stat label="Money in" value={formatCents(preview.totals.totalCents)} hint={`${preview.totals.outgoingCount} outgoing rows ignored`} />
              <Stat
                label="Entries earned"
                value={preview.totals.totalEntries.toLocaleString()}
                hint={preview.totals.unallocatedCents > 0 ? `${formatCents(preview.totals.unallocatedCents)} unallocated` : 'Nothing left over'}
              />
            </dl>

            {duplicateCount > 0 && (
              <Callout tone="warn" title={`${pluralize(duplicateCount, 'row')} already imported`}>
                These look identical to payments already in this drawing, so they will be parked as duplicates and
                earn no entries. If somebody genuinely paid twice on the same day for the same amount, you can
                approve them individually on the Review tab.
              </Callout>
            )}

            {preview.totals.flaggedCount > 0 && (
              <Callout tone="info" title={`${pluralize(preview.totals.flaggedCount, 'row')} flagged for review`}>
                Partial amounts, unusual dates, missing payers and similar. Every flag is explained on the Review tab.
              </Callout>
            )}

            <div>
              <h3 className="mb-2 text-sm font-medium text-ink-800">First 20 rows, as they will be read</h3>
              <div className="scroll-x rounded-lg ring-1 ring-ink-200">
                <table className="min-w-full text-sm">
                  <thead className="bg-ink-50 text-xs font-semibold uppercase tracking-column text-ink-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Row</th>
                      <th className="px-3 py-2 text-left font-medium">Date</th>
                      <th className="px-3 py-2 text-left font-medium">Payer</th>
                      <th className="px-3 py-2 text-right font-medium">Amount</th>
                      <th className="px-3 py-2 text-right font-medium">Entries</th>
                      <th className="px-3 py-2 text-left font-medium">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-ink-100">
                    {preview.rows.slice(0, 20).map((row, i) => (
                      <tr key={i} className={row.direction === 'out' ? 'bg-ink-50/60 text-ink-400' : ''}>
                        <td className="px-3 py-2 tabular text-ink-400">{row.sourceRowNumber}</td>
                        <td className="px-3 py-2 tabular">{row.paidOn ?? '—'}</td>
                        <td className="px-3 py-2">{row.rawPayerName ?? <span className="text-bad-600">no payer</span>}</td>
                        <td className="px-3 py-2 text-right tabular">
                          {row.direction === 'out' ? '−' : ''}{formatCents(row.amountCents)}
                        </td>
                        <td className="px-3 py-2 text-right tabular font-medium">{row.entries}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {row.flags.map((f) => (
                              <Badge key={f} tone={f === 'duplicate_suspected' ? 'warn' : 'neutral'}>{f}</Badge>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {preview.rejected.length > 0 && (
              <details className="rounded-lg bg-ink-50 px-4 py-3">
                <summary className="cursor-pointer text-sm font-medium text-ink-800">
                  <AlertTriangle className="mr-1 inline size-4 text-warn-700" aria-hidden />
                  {pluralize(preview.rejected.length, 'row')} skipped — usually balance lines and blank separators
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-ink-600">
                  {preview.rejected.slice(0, 30).map((r) => (
                    <li key={r.sourceRowNumber}>
                      Row {r.sourceRowNumber}: {r.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
              <Button variant="primary" onClick={() => void commitImport()} loading={busy}>
                <CheckCircle2 className="size-4" aria-hidden />
                Import {pluralize(preview.rows.length, 'payment')}
              </Button>
              <Button onClick={() => setPreview(null)}>Back to columns</Button>
              <span className="text-xs text-ink-400">
                Preset signature: <span className="hash">{headerSignature(headers).slice(0, 40)}…</span>
              </span>
            </div>
            {error && <Callout tone="bad">{error}</Callout>}
          </div>
        </Card>
      )}
    </div>
  )
}
