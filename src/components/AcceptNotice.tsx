import { useEffect, useState } from 'react'
import { Mark } from './brand'
import { Button } from './ui'

/**
 * The provenance notice.
 *
 * Shown once per browser after sign-in, and it has to be accepted — there is
 * no close button and Escape does nothing, because "requires an I accept" is
 * the whole joke.
 *
 * It lives inside RequireAdmin, so only whoever holds the passcode ever sees
 * it. The public verification page sits outside that gate and is untouched:
 * the thousand members checking a draw get the fairness record, not Dan's
 * espresso.
 *
 * Bump VERSION to make it appear again after the wording changes.
 */
const VERSION = 1
const STORAGE_KEY = `w2w.provenance.accepted.v${VERSION}`

/** localStorage throws outright in some privacy modes, so every touch is guarded. */
function readAccepted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'yes'
  } catch {
    return false
  }
}

function rememberAccepted(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, 'yes')
  } catch {
    // A browser that refuses to remember just shows this again next time,
    // which is a fine outcome for a joke and no reason to fail the sign-in.
  }
}

export function AcceptNotice() {
  const [open, setOpen] = useState(() => !readAccepted())

  useEffect(() => {
    if (!open) return
    // Hold the page still underneath, the same as the reveal overlay does.
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [open])

  if (!open) return null

  function accept() {
    rememberAccepted()
    setOpen(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 px-6 py-10 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="provenance-title"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-7 shadow-xl ring-1 ring-ink-200">
        <Mark height={24} />

        <h2
          id="provenance-title"
          className="mt-4 font-brand text-xl font-bold tracking-head text-ink-900"
        >
          Statement of provenance
        </h2>

        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          This site was not made by AI but by Dan sitting half naked with an espresso off the coast
          of the Adriatic, for Trevor to make his life easy.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-700">
          Any allegations of AI interference means Dan gets a Daytona for free from Trevor.
        </p>

        <div className="mt-6 flex justify-end">
          <Button autoFocus variant="primary" size="lg" onClick={accept}>
            I accept
          </Button>
        </div>
      </div>
    </div>
  )
}
