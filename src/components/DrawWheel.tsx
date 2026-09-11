import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Minimize2, Trophy, X } from 'lucide-react'
import {
  buildWedges, easeOutQuint, labelColorOn, planSpin, wedgeAtRotation, wedgeColor,
  type WheelEntrant,
} from '../lib/wheel'
import { formatOdds, pluralize } from '../lib/format'
import { BRAND, BrandStamp, Wordmark } from './brand'

/**
 * The reveal wheel.
 *
 * This is shown to a live audience of a thousand people, so two things matter
 * more than the animation itself:
 *
 * 1. It reveals, it does not decide. The winners were fixed by the Edge
 *    Function from the frozen entrant list and a public drand beacon, and are
 *    already recorded permanently. The wheel is told who won and works out the
 *    angle that lands on them. The header says so out loud, because a wheel
 *    that LOOKED like it was choosing while the result came from elsewhere
 *    would be a lie told to the audience.
 *
 * 2. It has to work at real scale. With ~1000 entrants each wedge is a
 *    fraction of a degree, so rim labels are impossible — the ring reads as a
 *    spinning band of colour and the NAME is read from the hub, which shows
 *    whoever is under the pointer at that instant. That is genuinely tied to
 *    the wheel's position rather than a decorative shuffle running alongside
 *    it, so as the wheel slows the names visibly slow with it.
 *
 * Wedge width is proportional to tickets, which makes the weighting legible:
 * four tickets visibly occupies four times the arc of one.
 */

export interface WheelResult {
  rank: number
  publicId: string
  displayLabel: string
  tickets: number
  isAlternate: boolean
}

interface Props {
  entrants: WheelEntrant[]
  results: WheelResult[]
  drawingName: string
  beaconRound: number | null
  onClose: () => void
}

const SPIN_MS = 7000
const LABEL_MIN_SWEEP_DEG = 7 // below this, rim text is unreadable

/**
 * Sizing for the name in the hub. Both constants are tied to the hub radius
 * (0.42 of the wheel), so they move together if that ever changes:
 *
 *  - WIDTH is the usable line across the white disc, in viewBox units.
 *    Manrope Bold runs near 0.58em per character, so a long display label
 *    shrinks to fit rather than running out onto the rotating wedges.
 *  - MAX is the ceiling for short labels, which would otherwise be sized only
 *    by the WIDTH formula and come out enormous. Measured in Chromium, the
 *    widest plausible 7-character label ("WM WWW.") lands at 96% of the disc
 *    at the old 6.4 ceiling — inside it, but touching the edge. 5.8 keeps
 *    short names at the same share of the disc they had before it shrank.
 */
const HUB_TEXT_WIDTH = 31
const HUB_TEXT_MAX = 5.8

function hubFontSize(name: string): number {
  return Math.min(HUB_TEXT_MAX, HUB_TEXT_WIDTH / Math.max(1, name.length * 0.58))
}

export function DrawWheel({ entrants, results, drawingName, beaconRound, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wheelRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number>(0)
  const rotationRef = useRef(0)

  const [index, setIndex] = useState(0)
  const [spinning, setSpinning] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [hubName, setHubName] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const reduceMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  const current = results[index]

  /**
   * The pool for this rank: everyone still in, with previous winners removed —
   * mirroring the real algorithm, where all of a winner's tickets leave the
   * pool so nobody can win twice.
   */
  const wedges = useMemo(() => {
    const taken = new Set(results.slice(0, index).map((r) => r.publicId))
    return buildWedges(entrants.filter((e) => !taken.has(e.publicId)))
  }, [entrants, results, index])

  const totalTickets = useMemo(() => wedges.reduce((sum, w) => sum + w.tickets, 0), [wedges])
  const showRimLabels = wedges.length > 0 && 360 / wedges.length >= LABEL_MIN_SWEEP_DEG

  /* ----------------------------------------------------------- rendering --- */

  const paint = useCallback(
    (highlight: string | null) => {
      const canvas = canvasRef.current
      if (!canvas || wedges.length === 0) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const size = canvas.clientWidth
      if (size === 0) return
      canvas.width = size * dpr
      canvas.height = size * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size, size)

      const cx = size / 2
      const cy = size / 2
      const radius = size / 2 - 6
      // Canvas angles start at 3 o'clock; our wedges start at 12 o'clock.
      const toCanvas = (deg: number) => ((deg - 90) * Math.PI) / 180

      wedges.forEach((w, i) => {
        const isWinner = highlight === w.publicId
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.arc(cx, cy, radius, toCanvas(w.startDeg), toCanvas(w.startDeg + w.sweepDeg))
        ctx.closePath()
        ctx.fillStyle = isWinner ? '#fceee8' : wedgeColor(i)
        ctx.fill()
        // Hairlines only while wedges are wide enough for them to read as
        // separators rather than as noise.
        if (w.sweepDeg > 1.5) {
          ctx.strokeStyle = 'rgba(255,255,255,0.55)'
          ctx.lineWidth = 1
          ctx.stroke()
        }
        if (isWinner) {
          ctx.strokeStyle = '#c2451c'
          ctx.lineWidth = 3
          ctx.stroke()
        }
      })

      if (showRimLabels) {
        ctx.font = '600 15px Manrope, system-ui, sans-serif'
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        for (const [i, w] of wedges.entries()) {
          ctx.save()
          ctx.translate(cx, cy)
          ctx.rotate(toCanvas(w.midDeg))
          // Ink or paper, whichever reads on this wedge's own fill. The index
          // has to match the one the fill was drawn with, hence entries().
          ctx.fillStyle = highlight === w.publicId ? '#0e1117' : labelColorOn(wedgeColor(i))
          const text = w.label.length > 18 ? `${w.label.slice(0, 17)}…` : w.label
          ctx.fillText(text, radius - 14, 0)
          ctx.restore()
        }
      }

      // Landing marker. With ~1000 entrants the winning wedge is about a tenth
      // of a degree wide and is invisible however it is filled, so once the
      // wheel stops we draw a spoke along its centre line. It is deliberately a
      // POINTER, not a widened wedge — overstating the arc would misrepresent
      // that person's odds to an audience watching a fairness demonstration.
      //
      // Only drawn when the wedges are too thin to label. On a small wheel the
      // highlighted wedge already reads clearly, and the spoke would run
      // straight through the winner's name.
      if (highlight && !showRimLabels) {
        const winner = wedges.find((w) => w.publicId === highlight)
        if (winner) {
          const a = toCanvas(winner.midDeg)
          ctx.save()
          ctx.beginPath()
          ctx.moveTo(cx + Math.cos(a) * radius * 0.44, cy + Math.sin(a) * radius * 0.44)
          ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius)
          ctx.strokeStyle = '#0e1117'
          ctx.lineWidth = 6
          ctx.lineCap = 'round'
          ctx.stroke()
          ctx.strokeStyle = '#fceee8'
          ctx.lineWidth = 3
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(cx + Math.cos(a) * radius * 0.93, cy + Math.sin(a) * radius * 0.93, 7, 0, Math.PI * 2)
          ctx.fillStyle = '#fceee8'
          ctx.fill()
          ctx.strokeStyle = '#0e1117'
          ctx.lineWidth = 2.5
          ctx.stroke()
          ctx.restore()
        }
      }

      // Hub
      ctx.beginPath()
      ctx.arc(cx, cy, radius * 0.42, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = 'rgba(14, 17, 23, 0.12)' // --ink at 12%
      ctx.lineWidth = 2
      ctx.stroke()
    },
    [wedges, showRimLabels],
  )

  useEffect(() => {
    paint(revealed && current ? current.publicId : null)
  }, [paint, revealed, current])

  useEffect(() => {
    const onResize = () => paint(revealed && current ? current.publicId : null)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [paint, revealed, current])

  /* ------------------------------------------------------------ spinning --- */

  const applyRotation = (deg: number) => {
    rotationRef.current = deg
    if (wheelRef.current) wheelRef.current.style.transform = `rotate(${deg}deg)`
  }

  const spin = useCallback(() => {
    if (!current || spinning || wedges.length === 0) return

    // Deterministic per rank, so a replay of the same draw looks the same.
    const jitter = ((current.rank * 2654435761) % 1000) / 1000
    const plan = planSpin(wedges, current.publicId, rotationRef.current, {
      turns: 5 + (current.rank % 3),
      durationMs: SPIN_MS,
      jitter,
    })
    if (!plan) return

    if (reduceMotion) {
      applyRotation(plan.toDeg)
      setHubName(current.displayLabel)
      setRevealed(true)
      return
    }

    setSpinning(true)
    setRevealed(false)
    const from = rotationRef.current
    const distance = plan.toDeg - from
    const started = performance.now()

    const step = (now: number) => {
      const t = Math.min(1, (now - started) / plan.durationMs)
      const deg = from + distance * easeOutQuint(t)
      applyRotation(deg)

      // The hub name is read off the wheel's actual position, so it slows down
      // exactly as the wheel does.
      const under = wedgeAtRotation(wedges, deg)
      setHubName(under?.label ?? null)

      if (t < 1) {
        frameRef.current = requestAnimationFrame(step)
      } else {
        applyRotation(plan.toDeg)
        setHubName(current.displayLabel)
        setSpinning(false)
        setRevealed(true)
      }
    }
    frameRef.current = requestAnimationFrame(step)
  }, [current, spinning, wedges, reduceMotion])

  useEffect(() => () => cancelAnimationFrame(frameRef.current), [])

  // Auto-start each rank shortly after it becomes current, so the operator
  // drives the show with one button per winner.
  useEffect(() => {
    const timer = setTimeout(() => spin(), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  /* ---------------------------------------------------------- fullscreen --- */

  const toggleFullscreen = async () => {
    if (!shellRef.current) return
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await shellRef.current.requestFullscreen()
    } catch {
      // Fullscreen can be refused (permissions, embedded contexts). The overlay
      // already fills the viewport, so this is a nicety rather than a
      // requirement — carry on either way.
    }
  }

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Stop the console behind from scrolling while the reveal is up. Without it
  // the page underneath shows through along the bottom edge, which a live
  // audience would see.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [])

  /* ----------------------------------------------------------------- UI --- */

  if (!current) return null

  const isLast = index >= results.length - 1

  return (
    <div
      ref={shellRef}
      className="fixed inset-0 z-50 flex h-[100dvh] w-screen flex-col overflow-y-auto bg-white"
      role="dialog"
      aria-modal="true"
      aria-label={`Drawing ${drawingName}`}
    >
      {/* Recorded surface. The wheel itself stays unmarked: a tiled watermark
          behind it and a mark inside the hub both competed with the name, which
          is the one thing a thousand people are watching for. The lockup sits
          at the bottom instead, where it still lands in every frame.

          It appears from md up, not sm: measured in Chromium, it overlaps the
          reveal's own button between 640 and ~704px. Below md the footer still
          carries the mark. */}
      <BrandStamp className="absolute bottom-16 right-6 z-20 hidden text-right md:block" />

      {/* Header: says plainly that the result already exists. */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-ink-200 bg-white/80 px-6 py-3 backdrop-blur-sm">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-900">{drawingName}</p>
          <p className="text-xs text-ink-500">
            {beaconRound
              ? `Decided by drand round ${beaconRound}. This is the reveal, not the decision.`
              : 'This is the reveal, not the decision.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void toggleFullscreen()}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-100"
          >
            {isFullscreen ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
            {isFullscreen ? 'Exit full screen' : 'Full screen'}
          </button>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-ink-100"
          >
            <X className="size-3.5" aria-hidden />
            Close
          </button>
        </div>
      </header>

      {/* Sized to fit whatever the stream is running at: the wheel takes the
          space left over rather than a fixed height, so nothing important ends
          up below the fold on a 720p capture. */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-4 sm:gap-4">
        <p className="shrink-0 text-xs font-semibold uppercase tracking-label text-ink-500">
          {current.isAlternate
            ? `Alternate ${current.rank - results.filter((r) => !r.isAlternate).length}`
            : `Winner ${current.rank}`}
          <span className="mx-2 text-ink-300">·</span>
          {pluralize(wedges.length, 'entrant')} · {pluralize(totalTickets, 'ticket')}
        </p>

        {/* Wheel */}
        <div className="relative aspect-square min-h-0 w-auto max-w-full flex-1">
          {/* Pointer at 12 o'clock */}
          <div
            className="absolute left-1/2 top-0 z-10 -translate-x-1/2"
            style={{
              width: 0, height: 0,
              borderLeft: '14px solid transparent',
              borderRight: '14px solid transparent',
              borderTop: '26px solid #c2451c',
              filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.25))',
            }}
            aria-hidden
          />
          <div ref={wheelRef} className="size-full will-change-transform">
            <canvas ref={canvasRef} className="size-full" />
          </div>

          {/*
            The hub name lives in the SVG rather than in HTML so that it scales
            with the wheel. A fixed CSS type size looked right at 1080p and
            wrapped at 720p, which is a resolution this actually gets streamed
            at.

            Nothing else goes in here. The reveal is a recorded surface and the
            wheel is the thing people watch, so the branding stays on the
            footer where it does not compete with the name.
          */}
          <svg
            className="pointer-events-none absolute inset-0 size-full"
            viewBox="0 0 100 100"
            aria-hidden
          >
            <text
              className="font-brand transition-opacity"
              x="50"
              y="50"
              textAnchor="middle"
              dominantBaseline="middle"
              fontWeight="700"
              fontSize={hubFontSize(hubName ?? '—')}
              fill="#0e1117"
              opacity={spinning ? 0.65 : 1}
            >
              {hubName ?? '—'}
            </text>
          </svg>
        </div>

        {/* Result card */}
        <div className="min-h-28 w-full max-w-2xl shrink-0 text-center">
          {revealed ? (
            <div className="animate-[fadeUp_320ms_ease-out] rounded-2xl bg-good-50 px-6 py-4 ring-1 ring-good-200">
              <Trophy className="mx-auto size-6 text-good-600" aria-hidden />
              <p className="mt-1 font-brand text-3xl font-bold tracking-display text-good-900 sm:text-5xl">
                {current.displayLabel}
              </p>
              <p className="mt-1.5 text-sm text-good-800">
                held {pluralize(current.tickets, 'ticket')} of {totalTickets.toLocaleString()} —{' '}
                {formatOdds(current.tickets, totalTickets)}
              </p>
            </div>
          ) : (
            <p className="pt-8 text-sm text-ink-400">{spinning ? 'Spinning…' : 'Getting ready…'}</p>
          )}
        </div>

        {/* Controls */}
        <div className="flex min-h-11 shrink-0 items-center gap-3">
          {revealed && !isLast && (
            <button
              onClick={() => { setRevealed(false); setIndex((i) => i + 1) }}
              className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
            >
              {results[index + 1]?.isAlternate ? 'Draw the next alternate' : 'Draw the next winner'}
            </button>
          )}
          {revealed && isLast && (
            <button
              onClick={onClose}
              className="rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
            >
              Done — show the full results
            </button>
          )}
        </div>
      </div>

      <footer className="shrink-0 border-t border-ink-200 bg-white/80 px-6 py-2 text-center backdrop-blur-sm">
        <span className="text-xs text-ink-400">
          Made by <Wordmark size="sm" className="align-baseline" />
          <span className="mx-2 text-ink-300">&middot;</span>
          {BRAND.motto}
        </span>
      </footer>

      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  )
}
