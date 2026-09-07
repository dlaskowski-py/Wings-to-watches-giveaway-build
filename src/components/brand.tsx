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
      <span className="font-bold">ADJL</span>{' '}
      <span className="font-light" style={{ color: onDark ? SIGNAL : SIGNAL_DEEP }}>
        Capital Technology
      </span>
    </span>
  )
}

/**
 * The "made by" strip.
 *
 * A dark band at the foot of the page. The identity is dark-first, so this is
 * the one surface where the mark appears the way it was designed — bone and
 * copper on ink — without turning the whole console dark.
 */
export function BrandFooter({ className }: { className?: string }) {
  return (
    <footer className={clsx('mt-16 px-6 py-6', className)} style={{ background: INK }}>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <p className="text-xs" style={{ color: '#6e6b66' }}>
          Made by <Wordmark tone="dark" size="sm" className="align-baseline" />
        </p>
        <p className="text-xs" style={{ color: '#6e6b66' }}>
          Today&rsquo;s investment. Tomorrow&rsquo;s{' '}
          <span className="font-light" style={{ color: SIGNAL }}>
            legacy.
          </span>
        </p>
      </div>
    </footer>
  )
}
