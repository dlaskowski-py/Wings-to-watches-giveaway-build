import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { Check, Copy, Loader2 } from 'lucide-react'

/* -------------------------------------------------------------------------- *
 * Buttons
 * -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}) {
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300 shadow-sm',
    secondary: 'bg-white text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 disabled:text-ink-300',
    ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900 disabled:text-ink-300',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300 shadow-sm',
  }
  const sizes = {
    sm: 'px-2.5 py-1.5 text-xs gap-1.5',
    md: 'px-3.5 py-2 text-sm gap-2',
    lg: 'px-5 py-2.5 text-sm gap-2',
  }
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
        'disabled:cursor-not-allowed',
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- *
 * Surfaces
 * -------------------------------------------------------------------------- */

export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <section className={clsx('rounded-xl bg-white ring-1 ring-ink-200/70 shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  )
}

/* -------------------------------------------------------------------------- *
 * Status
 * -------------------------------------------------------------------------- */

type Tone = 'neutral' | 'info' | 'warn' | 'good' | 'bad'

const TONE_CLASSES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  info: 'bg-brand-50 text-brand-800 ring-brand-200',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200',
  good: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  bad: 'bg-red-50 text-red-800 ring-red-200',
}

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Callout({ tone = 'info', title, children }: { tone?: Tone; title?: ReactNode; children: ReactNode }) {
  return (
    <div className={clsx('rounded-lg px-4 py-3 text-sm ring-1 ring-inset', TONE_CLASSES[tone])}>
      {title && <p className="font-semibold">{title}</p>}
      <div className={clsx(title && 'mt-1', 'leading-relaxed')}>{children}</div>
    </div>
  )
}

/* -------------------------------------------------------------------------- *
 * Numbers
 * -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: Tone
}) {
  const valueTone =
    tone === 'bad' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : tone === 'good' ? 'text-emerald-700' : 'text-ink-900'
  return (
    <div className="rounded-lg bg-ink-50/70 px-4 py-3 ring-1 ring-ink-100">
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd className={clsx('mt-1 text-xl font-semibold tabular', valueTone)}>{value}</dd>
      {hint && <p className="mt-0.5 text-xs text-ink-400">{hint}</p>}
    </div>
  )
}

/* -------------------------------------------------------------------------- *
 * Form controls
 * -------------------------------------------------------------------------- */

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-800">
        {label}
      </label>
      {hint && <p className="mt-0.5 text-xs text-ink-500">{hint}</p>}
      <div className="mt-1.5">{children}</div>
      {error && <p className="mt-1 text-xs font-medium text-red-600">{error}</p>}
    </div>
  )
}

const CONTROL =
  'block w-full rounded-lg border-0 bg-white px-3 py-2 text-sm text-ink-900 ring-1 ring-inset ring-ink-200 ' +
  'placeholder:text-ink-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 disabled:bg-ink-50 disabled:text-ink-400'

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx(CONTROL, className)} />
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx(CONTROL, 'pr-8', className)}>
      {children}
    </select>
  )
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx(CONTROL, className)} />
}

/* -------------------------------------------------------------------------- *
 * Copy-to-clipboard
 *
 * Used constantly on the lock screen: the operator copies the commitment values
 * out to paste into the group chat, and a mistyped hash makes verification fail
 * for everyone.
 * -------------------------------------------------------------------------- */

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
        } catch {
          // Clipboard can be blocked (insecure context, permissions). Fall back
          // to selecting the text so the operator can copy it by hand.
          window.prompt('Copy this value:', value)
        }
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

/** A hash or seed shown in full, with a copy button. */
export function HashValue({ label, value, muted }: { label: string; value: string | null; muted?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-ink-500">{label}</span>
        {value && <CopyButton value={value} />}
      </div>
      <p className={clsx('hash mt-0.5 text-xs', muted ? 'text-ink-400' : 'text-ink-800')}>
        {value ?? 'Not set yet'}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- *
 * States
 * -------------------------------------------------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-ink-400', className)} aria-hidden />
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-ink-500">
      <Spinner />
      {label}
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-800">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function ErrorBlock({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return (
    <Callout tone="bad" title="Something went wrong">
      {message}
    </Callout>
  )
}
