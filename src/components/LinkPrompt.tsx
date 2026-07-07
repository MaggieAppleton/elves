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
  const inputRef = useRef<HTMLInputElement>(null)

  // Each time the modal opens: clear the field and focus it (after paint, so
  // the autofocus lands on the freshly-mounted input).
  useEffect(() => {
    if (!open) return
    setValue('')
    setBusy(false)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

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
        className="elves-linkprompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elves-linkprompt-title"
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
