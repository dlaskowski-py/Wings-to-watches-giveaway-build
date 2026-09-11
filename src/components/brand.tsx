import { clsx } from 'clsx'

/**
 * ADJL Technology mark, per the brand kit.
 *
 * The mark is three bars: the firm's initial reduced to a shape. Outer bars in
 * ink, centre bar in the copper signal at 55% of their width. That proportion
 * IS the mark — set the bars at equal widths and it reads as a bar chart.
 *
 * Colour follows the ground: ink bars on a light one, paper bars on ink. The
 * centre bar stays copper on both, and never becomes teal or violet.
 *
 * The wordmark pairs it with "ADJL" at 700 and the tail at 400 in --ink-3. Note
 * that the copper lives in the MARK here, not in the word — that is the
 * difference between this kit and the Capital one it descends from.
 */

/**
 * Every piece of ADJL wording lives here. The name goes out on a livestream
 * watched by the whole group, so it is defined once rather than typed into a
 * dozen components where one could drift.
 *
 * The kit's own wordmark reads "ADJL Technology". This console says "ADJL
 * Capital Technology" because that is the name it was explicitly given.
 */
export const BRAND = {
  /** Rendered bold. */
  lead: 'ADJL',
  /** Rendered regular, in --ink-3. */
  rest: 'Capital Technology',
  full: 'ADJL Capital Technology',
  motto: 'Today\u2019s investment. Tomorrow\u2019s legacy.',
  /** Motto split so "legacy." can carry the accent colour. */
  mottoLead: 'Today\u2019s investment. Tomorrow\u2019s',
  mottoAccent: 'legacy.',
} as const

/*
 * Construction, straight from the kit. One unit is the width of an outer bar,
 * so the whole mark scales from a single number.
 */
export const MARK = {
  bar: 1,
  centre: 0.55,
  gap: 0.42,
  height: 3.67,
  radius: 0.22,
  get width() {
    return this.bar * 2 + this.centre + this.gap * 2
  },
} as const

const BAR = MARK.bar
const CENTRE = MARK.centre
const GAP = MARK.gap
const HEIGHT = MARK.height
const RADIUS = MARK.radius
const WIDTH = MARK.width

/** The kit's floor. Below this the centre bar stops reading as a third bar. */
const MIN_HEIGHT_PX = 16

export function Mark({
  height = 20,
  tone = 'light',
  className,
}: {
  /** Rendered height in px. Clamped to the kit's 16px minimum. */
  height?: number
  /** 'dark' = sitting on an ink ground; 'light' = sitting on a pale ground. */
  tone?: 'light' | 'dark'
  className?: string
}) {
  const h = Math.max(MIN_HEIGHT_PX, height)
  const bars = tone === 'dark' ? 'var(--color-ink-50)' : 'var(--color-ink-900)'
  return (
    <svg
      className={clsx('inline-block shrink-0 align-middle', className)}
      style={{ height: h, width: (h * WIDTH) / HEIGHT }}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      fill="none"
      aria-hidden
      focusable="false"
    >
      <rect x={0} y={0} width={BAR} height={HEIGHT} rx={BAR * RADIUS} fill={bars} />
      <rect
        x={BAR + GAP}
        y={0}
        width={CENTRE}
        height={HEIGHT}
        rx={CENTRE * RADIUS}
        fill="var(--color-brand-500)"
      />
      <rect x={BAR + GAP + CENTRE + GAP} y={0} width={BAR} height={HEIGHT} rx={BAR * RADIUS} fill={bars} />
    </svg>
  )
}

const SIZES = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
} as const

/**
 * Mark height per type size. Slightly taller than the em box so the bars read
 * as a mark rather than as a letter, and centred on the line box.
 */
const MARK_HEIGHTS: Record<keyof typeof SIZES, number> = { sm: 16, md: 18, lg: 21 }

export function Wordmark({
  tone = 'light',
  size = 'md',
  showMark = true,
  className,
}: {
  /** 'dark' = sitting on an ink ground; 'light' = sitting on a pale ground. */
  tone?: 'light' | 'dark'
  size?: keyof typeof SIZES
  /** The kit's lockup includes the mark; drop it where the mark already sits nearby. */
  showMark?: boolean
  className?: string
}) {
  const onDark = tone === 'dark'
  return (
    <span
      className={clsx(
        'font-brand inline-flex items-center gap-1.5 tracking-head whitespace-nowrap',
        SIZES[size],
        onDark ? 'text-ink-50' : 'text-ink-900',
        className,
      )}
    >
      {showMark && <Mark tone={tone} height={MARK_HEIGHTS[size]} />}
      <span>
        <span className="font-bold">{BRAND.lead}</span>{' '}
        {/* Below 900px the kit's compact lockup is the mark and "ADJL" alone. */}
        <span className={clsx('hidden font-normal lockup:inline', onDark ? 'text-ink-300' : 'text-ink-500')}>
          {BRAND.rest}
        </span>
      </span>
    </span>
  )
}

/**
 * The "made by" strip.
 *
 * Separated by a hairline rather than a filled band, which is the identity's
 * own device: it divides by line, not by card. The one copper word is the
 * text-safe --signal-deep, never the bright --signal, which the kit reserves
 * for rules and art at 24px and up.
 */
export function BrandFooter({ className }: { className?: string }) {
  return (
    <footer className={clsx('border-t border-ink-200 bg-white px-6 py-6', className)}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <p className="flex items-center gap-1.5 text-xs text-ink-500">
          Made by <Wordmark size="sm" className="align-baseline" />
        </p>
        <p className="text-xs text-ink-500">
          {BRAND.mottoLead} <span className="font-brand font-semibold text-brand-600">{BRAND.mottoAccent}</span>
        </p>
      </div>
    </footer>
  )
}

/**
 * Persistent corner attribution.
 *
 * Full opacity and always on top — this is the mark that has to be legible in
 * the recording, where the tiled layer only survives as texture.
 */
export function BrandStamp({ className }: { className?: string }) {
  return (
    <div className={clsx('pointer-events-none select-none', className)} aria-hidden>
      <Wordmark size="sm" />
      {/* text-xs is 0.75rem — the kit's label floor, and not a value to nudge down. */}
      <p className="mt-0.5 font-brand text-xs text-ink-500">{BRAND.motto}</p>
    </div>
  )
}
