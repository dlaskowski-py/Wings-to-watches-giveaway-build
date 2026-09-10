/**
 * Wheel geometry.
 *
 * ============================================================================
 * THE WHEEL DOES NOT DECIDE ANYTHING.
 * ============================================================================
 *
 * By the time anything here runs, the winners are already fixed: chosen by the
 * Edge Function from the frozen entrant list and a public drand beacon, and
 * written to the database permanently. This module's whole job is to work out
 * the exact angle that puts an ALREADY-KNOWN winner under the pointer.
 *
 * That distinction matters more than usual here, because the draw is being
 * live-streamed to a thousand people who are being asked to trust it. A wheel
 * that appeared to choose, while the real result came from somewhere else,
 * would be a lie told to the audience — even a well-intentioned one. So the
 * animation is presented as a reveal, the copy says so, and the maths below
 * takes the winner as an input rather than producing one.
 *
 * Layout convention: wedge 0 starts at 12 o'clock and they run CLOCKWISE, sized
 * in proportion to tickets. The pointer sits at 12 o'clock. Rotating the wheel
 * by `-midpoint` therefore brings that wedge under the pointer.
 */

export interface WheelEntrant {
  publicId: string
  label: string
  tickets: number
}

export interface Wedge extends WheelEntrant {
  /** Degrees clockwise from 12 o'clock where this wedge begins. */
  startDeg: number
  /** Degrees of arc this wedge occupies — proportional to its ticket count. */
  sweepDeg: number
  /** Degrees clockwise from 12 o'clock at the middle of this wedge. */
  midDeg: number
}

/**
 * Lay entrants out around the circle, arc proportional to tickets.
 *
 * Sorted by publicId so the layout matches the canonical snapshot order — the
 * same order a verifier sees. Someone holding four tickets visibly occupies
 * four times the arc of someone holding one, which is the fairness rule made
 * legible rather than merely asserted.
 */
export function buildWedges(entrants: readonly WheelEntrant[]): Wedge[] {
  const usable = entrants.filter((e) => e.tickets > 0)
  const total = usable.reduce((sum, e) => sum + e.tickets, 0)
  if (total === 0) return []

  const ordered = [...usable].sort((a, b) =>
    a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0,
  )

  const wedges: Wedge[] = []
  let cursor = 0
  for (const e of ordered) {
    const sweepDeg = (e.tickets / total) * 360
    wedges.push({ ...e, startDeg: cursor, sweepDeg, midDeg: cursor + sweepDeg / 2 })
    cursor += sweepDeg
  }
  // Absorb floating-point drift into the final wedge so the ring always closes.
  const last = wedges[wedges.length - 1]
  if (last) last.sweepDeg = 360 - last.startDeg

  return wedges
}

export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/**
 * Which wedge currently sits under the pointer, given the wheel's rotation.
 *
 * Drives the name that flickers past during the spin, so what the audience
 * reads is genuinely tied to the wheel's position rather than a decorative
 * shuffle running alongside it.
 */
export function wedgeAtRotation(wedges: readonly Wedge[], rotationDeg: number): Wedge | null {
  if (wedges.length === 0) return null
  // Rotating the wheel by +r moves wedge angles to (start + r), so the wedge
  // under a fixed pointer at 0 is the one containing (-r).
  const target = normalizeDeg(-rotationDeg)

  let lo = 0
  let hi = wedges.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (wedges[mid]!.startDeg <= target) lo = mid
    else hi = mid - 1
  }
  return wedges[lo] ?? null
}

export interface SpinPlan {
  /** Absolute rotation to animate to, in degrees. Always greater than `fromDeg`. */
  toDeg: number
  /** How long the spin should run, in milliseconds. */
  durationMs: number
}

/**
 * Work out the rotation that lands `winnerPublicId` under the pointer.
 *
 * `jitter` (0..1) nudges the resting position away from the exact centre of the
 * wedge so repeated spins do not all stop identically — cosmetic only, and
 * clamped well inside the wedge so it can never change which one is selected.
 * It is passed in rather than generated here so the animation stays a pure
 * function of its inputs and can be replayed identically.
 */
export function planSpin(
  wedges: readonly Wedge[],
  winnerPublicId: string,
  fromDeg: number,
  options: { turns?: number; durationMs?: number; jitter?: number } = {},
): SpinPlan | null {
  const winner = wedges.find((w) => w.publicId === winnerPublicId)
  if (!winner) return null

  const { turns = 6, durationMs = 7000, jitter = 0.5 } = options

  // Keep the resting point inside the middle 70% of the wedge. At 1000 entrants
  // a wedge is a fraction of a degree wide, so this margin is what stops
  // rounding from parking the pointer on a neighbour.
  const clamped = Math.min(1, Math.max(0, jitter))
  const offsetFromMid = (clamped - 0.5) * winner.sweepDeg * 0.7
  const restingRotation = normalizeDeg(-(winner.midDeg + offsetFromMid))

  // Advance to the next multiple of 360 above `fromDeg`, then add whole turns,
  // so the wheel always spins forwards and never snaps backwards.
  const base = Math.ceil(fromDeg / 360) * 360
  const toDeg = base + turns * 360 + restingRotation

  return { toDeg: toDeg <= fromDeg ? toDeg + 360 : toDeg, durationMs }
}

/**
 * Deceleration curve. Quintic ease-out: quick off the line, then a long slow
 * settle that reads well on a stream and gives the audience time to see the
 * names slow down.
 */
export function easeOutQuint(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return 1 - Math.pow(1 - clamped, 5)
}

/**
 * Wedge colours, from the ADJL Technology spectrum.
 *
 * Copper and teal are the two halves of the kit's own palette, alternated so
 * neighbours always differ and so the ring reads as a band rather than a clown
 * wheel when a thousand wedges blur together at speed. These are fills, never
 * text, which is why the art-only --teal can appear here.
 *
 * Violet is deliberately absent: the kit assigns it to inference and models,
 * and a giveaway wheel is neither. Using it decoratively would spend a
 * meaning the rest of the system relies on.
 */
export const WHEEL_COLORS = [
  '#d9542a', // signal
  '#0a7070', // teal deep
  '#e2734b', // signal, lightened
  '#1f5e4e', // viridian
  '#c2451c', // signal deep
  '#0fa3a3', // teal
] as const

/** Relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255)
}

const LABEL_INK = '#0e1117'
const LABEL_PAPER = '#fafafc'

/**
 * Ink or paper, whichever actually measures better on the given fill.
 *
 * The wheel's palette spans a light copper and a dark teal, so one fixed label
 * colour cannot serve both: white on #E2734B is 2.97:1 and unreadable at the
 * size a rim label is drawn. This compares the two candidates rather than
 * testing luminance against a threshold — the crossover sits at 0.187 for this
 * pair, which is not a number anyone would guess, and it moves if either
 * candidate changes.
 */
export function labelColorOn(fill: string): string {
  const target = luminance(fill)
  const ratio = (c: string) => {
    const [hi, lo] = [luminance(c), target].sort((a, b) => b - a) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }
  return ratio(LABEL_INK) >= ratio(LABEL_PAPER) ? LABEL_INK : LABEL_PAPER
}

export function wedgeColor(index: number): string {
  return WHEEL_COLORS[index % WHEEL_COLORS.length]!
}
