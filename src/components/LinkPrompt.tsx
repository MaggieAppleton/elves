import { useEffect, useRef, useState } from 'react'
import './linkPrompt.css'

interface Props {
  open: boolean
  onCancel: () => void
  /** Resolve the pasted link into a reference card. May be async (unfurl). */
  onSubmit: (url: string) => Promise<void> | void
}

/**
 * The in-app replacement for `window.prompt` when adding a reference by URL.
 * A spare, native-feeling modal in the app's own paper palette rather than the
 * browser's chrome-coloured dialog. Enter submits, Escape (or a backdrop click)
 * cancels, and the submit button carries an "Adding…" state while the server
 * unfurls the link so a slow fetch never looks frozen.
 */
export function LinkPrompt({ open, onCancel, onSubmit }: Props) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  // Each time the modal opens: clear the field and focus it (after paint, so
  // the autofocus lands on the freshly-mounted input).
  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    setValue('')
    setBusy(false)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(id)
      const opener = openerRef.current
      openerRef.current = null
      if (opener?.isConnected) opener.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (!busy) onCancel()
        return
      }
      if (e.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])',
      ))
      e.stopPropagation()
      if (controls.length === 0) {
        e.preventDefault()
        dialog.focus()
        return
      }

      const first = controls[0]
      const last = controls[controls.length - 1]
      const active = document.activeElement
      if (active === dialog || !dialog.contains(active)) {
        e.preventDefault()
        const destination = e.shiftKey ? last : first
        destination.focus()
      } else if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, busy, onCancel])

  // Busy disables every form control; keep focus inside the modal on the dialog
  // itself until the unfurl completes.
  useEffect(() => {
    if (open && busy) dialogRef.current?.focus()
  }, [open, busy])

  if (!open) return null

  const trimmed = value.trim()
  const submit = async () => {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await onSubmit(trimmed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="elves-linkprompt__backdrop"
      data-testid="link-prompt"
      onMouseDown={() => {
        if (!busy) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        className="elves-linkprompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elves-linkprompt-title"
        aria-busy={busy}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="elves-linkprompt__title" id="elves-linkprompt-title">
          Add a reference
        </h2>
        <p className="elves-linkprompt__hint">
          Paste a link and Elves will pull in its title and details.
        </p>
        <input
          ref={inputRef}
          className="elves-linkprompt__input"
          type="url"
          inputMode="url"
          placeholder="https://…"
          data-testid="link-prompt-input"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="elves-linkprompt__actions">
          <button
            type="button"
            className="elves-linkprompt__btn"
            data-testid="link-prompt-cancel"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="elves-linkprompt__btn elves-linkprompt__btn--primary"
            data-testid="link-prompt-submit"
            onClick={submit}
            disabled={!trimmed || busy}
          >
            {busy ? 'Adding…' : 'Add link'}
          </button>
        </div>
      </div>
    </div>
  )
}
