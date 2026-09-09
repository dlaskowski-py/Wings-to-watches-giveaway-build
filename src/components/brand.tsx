import { clsx } from 'clsx'

/**
 * ADJL Capital Technology mark.
 *
 * Drawn from the ADJL Capital identity system: the wordmark is two weights of
 * Manrope with one word in colour — 700 for "ADJL", 300 for the rest. There is
 * no symbol, no lockup and no containing shape; the weight contrast IS the mark,
 * so it needs no clear-space rule beyond the leading of its line.
 *
 * The kit specifies different colour for different grounds, and that rule is
 * followed here rather than reused blindly:
 *
 *   on a dark ground  ->  bone text with the copper Signal (#D9663C)
 *   on a light ground ->  ink text with Signal deep (#A94A29), which is the
 *                         darker copper the kit provides precisely because the
 *                         standard Signal does not hold contrast on bone
 *
 * That is why the header mark is not literally white: white on a white header
 * would be invisible. The white mark lives in the dark footer strip, which is
 * the ground the identity is actually designed for.
 */

/**
 * Every piece of ADJL wording lives here. The name appears on a livestream
 * watched by the whole group, so it is defined once rather than typed into a
 * dozen components where one could drift.
 */
export const BRAND = {
  /** Rendered bold. */
  lead: 'ADJL',
  /** Rendered light, in copper. */
  rest: 'Capital Technology',
  full: 'ADJL Capital Technology',
  motto: 'Today\u2019s investment. Tomorrow\u2019s legacy.',
  /** Motto split so "legacy." can carry the accent colour. */
  mottoLead: 'Today\u2019s investment. Tomorrow\u2019s',
  mottoAccent: 'legacy.',
} as const

const INK = '#0a0a0b'
const BONE = '#efeae1'
const SIGNAL = '#d9663c'
const SIGNAL_DEEP = '#a94a29'

const SIZES = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
} as const

export function Wordmark({
  tone = 'light',
  size = 'md',
  className,
}: {
  /** 'dark' = sitting on an ink ground; 'light' = sitting on a pale ground. */
  tone?: 'light' | 'dark'
  size?: keyof typeof SIZES
  className?: string
}) {
  const onDark = tone === 'dark'
  return (
    <span
      className={clsx('font-brand tracking-[-0.02em] whitespace-nowrap', SIZES[size], className)}
      style={{ color: onDark ? BONE : INK }}
    >
      <span className="font-bold">{BRAND.lead}</span>{' '}
      <span className="font-light" style={{ color: onDark ? SIGNAL : SIGNAL_DEEP }}>
        {BRAND.rest}
      </span>
    </span>
  )
}

/**
 * The "made by" strip.
 *
 * On a white ground, so the mark uses the kit's light-ground pairing: ink for
 * "ADJL", Signal deep for the rest. That darker copper is not a substitute for
 * the accent, it IS the accent for this ground — the kit provides it precisely
 * because the standard Signal (#D9663C) only reaches about 3.5:1 on white and
 * fails WCAG AA for body text, while Signal deep reaches about 5.7:1.
 *
 * Separated by a hairline rather than a filled band, which is the identity's
 * own device: it divides by line, not by card.
 */
export function BrandFooter({ className }: { className?: string }) {
  return (
    <footer className={clsx('border-t border-ink-200 bg-white px-6 py-6', className)}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-ink-500">
          Made by <Wordmark size="sm" className="align-baseline" />
        </p>
        <p className="text-xs text-ink-400">
          {BRAND.mottoLead}{' '}
          <span className="font-brand font-light" style={{ color: SIGNAL_DEEP }}>
            {BRAND.mottoAccent}
          </span>
        </p>
      </div>
    </footer>
  )
}

/**
 * Tiled watermark.
 *
 * Sized and weighted to survive a livestream rather than to look subtle in a
 * design tool. Streaming codecs throw away low-contrast detail first, so the
 * usual 3-4% opacity watermark simply disappears once the feed is encoded —
 * `strength: 'stream'` sits around 9%, which reads on a compressed capture
 * without competing with the winner's name.
 *
 * Renders as real rotated text rather than an SVG data URI so it uses the brand
 * font and stays crisp at any zoom. Inert and hidden from assistive tech.
 */
export function Watermark({
  strength = 'ui',
  rows = 14,
  className,
}: {
  /** 'ui' for ordinary screens; 'stream' for anything being screen-recorded. */
  strength?: 'ui' | 'stream'
  rows?: number
  className?: string
}) {
  const opacity = strength === 'stream' ? 0.09 : 0.05
  const phrase = `${BRAND.full}  \u00b7  ${BRAND.motto}  \u00b7  `
  // Enough repeats to span the widest viewport at this rotation.
  const line = phrase.repeat(8)

  return (
    <div
      aria-hidden
      className={clsx('pointer-events-none absolute inset-0 select-none overflow-hidden', className)}
      style={{ opacity }}
    >
      <div className="absolute -inset-[35%] flex -rotate-[24deg] flex-col justify-around">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="whitespace-nowrap font-brand font-semibold uppercase"
            style={{
              color: INK,
              fontSize: strength === 'stream' ? '1.05rem' : '0.8rem',
              letterSpacing: '0.28em',
              // Offset alternate rows so the tiling does not read as columns.
              transform: `translateX(${i % 2 === 0 ? '0' : '-6rem'})`,
            }}
          >
            {line}
          </div>
        ))}
      </div>
    </div>
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
      <p className="mt-0.5 font-brand text-[0.68rem] tracking-wide text-ink-400">{BRAND.motto}</p>
    </div>
  )
}
