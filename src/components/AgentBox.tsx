import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Broom, PaperPlaneRight, X } from '@phosphor-icons/react'
import { agentInfo } from '../shapes/agents'
import { runAgent, type AgentEvent, type AgentRunHandle } from '../client/agent'
import './agentBox.css'

interface Props {
  open: boolean
  /** Null while no project is open — submit is disabled until one is. */
  projectId: string | null
  /** How many shapes are selected right now — drives the scope chip and whether
   * the agent is told to read_selection (scope to these) or read_map (whole canvas). */
  selectedCount: number
  onClose: () => void
}

// The transcript is a flat list of rendered lines derived from the event stream.
type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; summary: string }
  | { kind: 'error'; message: string }

// Fold one event into the transcript. `done` only contributes a line when the
// agent never spoke (tool-only run) — otherwise its reply just echoes the last
// text block, so we drop it and let `running` flip off.
function appendEvent(prev: Entry[], e: AgentEvent): Entry[] {
  switch (e.type) {
    case 'text':
      return [...prev, { kind: 'text', text: e.text }]
    case 'tool':
      return [...prev, { kind: 'tool', name: e.name, summary: e.summary }]
    case 'error':
      return [...prev, { kind: 'error', message: e.message }]
    case 'done':
      return e.reply && !prev.some((en) => en.kind === 'text')
        ? [...prev, { kind: 'text', text: e.reply }]
        : prev
    default:
      return prev
  }
}

/**
 * The in-app agent box: press `/` on the canvas to open it, type a request, and
 * a headless agent (Claude by default) works your canvas through the MCP while
 * its transcript streams here. Floating bottom-middle; Enter sends, Esc closes.
 *
 * Kept mounted and hidden (returns null) rather than unmounted, so an in-flight
 * run and its transcript survive closing and reopening the box.
 */
export function AgentBox({ open, projectId, selectedCount, onClose }: Props) {
  const claude = agentInfo('claude')
  const hasSelection = selectedCount > 0
  const scopeLabel = hasSelection
    ? `${selectedCount} selected`
    : 'Whole canvas'
  const [prompt, setPrompt] = useState('')
  const [entries, setEntries] = useState<Entry[]>([])
  const [running, setRunning] = useState(false)
  const handleRef = useRef<AgentRunHandle | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Focus the field each time the box opens (after paint, so the freshly-shown
  // element is focusable).
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Esc closes. Capture-phase + stopPropagation so tldraw's own Escape handler
  // (deselect) doesn't also fire underneath the open box.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Keep the newest transcript line in view as it streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries, running])

  // Auto-grow the input to fit its content (up to the CSS max-height, past which
  // it scrolls). Reset to `auto` first so scrollHeight reflects the text's
  // natural height and the field can shrink again when it's cleared or trimmed.
  // Layout effect (not plain effect) so the resize lands before paint — otherwise
  // a wrapped line or paste flashes clipped at the old height for one frame.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [prompt])

  const submit = () => {
    const text = prompt.trim()
    if (!text || running || !projectId) return
    setPrompt('')
    // Seed the transcript with the user's message so it stays pinned above the
    // tool calls and replies that follow.
    setEntries([{ kind: 'user', text }])
    setRunning(true)
    handleRef.current = runAgent({ prompt: text, projectId, hasSelection }, (e) => {
      setEntries((prev) => appendEvent(prev, e))
      if (e.type === 'done' || e.type === 'error') setRunning(false)
    })
  }

  const cancel = () => {
    handleRef.current?.cancel()
    setRunning(false)
  }

  // Close and forget: cancel any in-flight run, empty the transcript and
  // input, then close — unlike plain close, which preserves the chat.
  const closeAndClear = () => {
    handleRef.current?.cancel()
    setRunning(false)
    setEntries([])
    setPrompt('')
    onClose()
  }

  if (!open) return null

  const hasTranscript = entries.length > 0 || running

  return (
    <div className="elves-agentbox" role="dialog" aria-label="Ask an agent">
      <div className="elves-agentbox__header">
        <span className="elves-agentbox__who">
          {claude && <claude.Logo className="elves-agentbox__logo" aria-hidden="true" />}
          {claude?.name ?? 'Agent'}
        </span>
        <span
          className="elves-agentbox__scope"
          data-selection={hasSelection}
          data-testid="agent-scope"
          title={hasSelection ? 'The agent will work on your selected cards' : 'The agent will work across the whole canvas'}
        >
          {scopeLabel}
        </span>
        <div className="elves-agentbox__actions">
          <button
            className="elves-agentbox__close"
            onClick={closeAndClear}
            title="Clear chat"
            aria-label="Clear chat and close"
            data-testid="agent-clear"
          >
            <Broom aria-hidden="true" />
          </button>
          <button className="elves-agentbox__close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <X aria-hidden="true" />
          </button>
        </div>
      </div>

      {hasTranscript && (
        <div className="elves-agentbox__transcript" ref={scrollRef} data-testid="agent-transcript">
          {entries.map((en, i) =>
            en.kind === 'user' ? (
              <p className="elves-agentbox__user" key={i}>
                {en.text}
              </p>
            ) : en.kind === 'text' ? (
              <p className="elves-agentbox__text" key={i}>
                {en.text}
              </p>
            ) : en.kind === 'tool' ? (
              <p className="elves-agentbox__tool" key={i}>
                <span className="elves-agentbox__tool-name">{en.name.replace(/_/g, ' ')}</span>
                {en.summary && <span className="elves-agentbox__tool-summary"> {en.summary}</span>}
              </p>
            ) : (
              <p className="elves-agentbox__error" key={i}>
                {en.message}
              </p>
            ),
          )}
          {running && (
            <p className="elves-agentbox__working" aria-live="polite">
              <span className="elves-agentbox__dot" />
              working…
            </p>
          )}
        </div>
      )}

      <div className="elves-agentbox__inputrow">
        <textarea
          ref={inputRef}
          className="elves-agentbox__input"
          rows={1}
          placeholder="Ask the agent to critique, dedupe, reorganise…"
          data-testid="agent-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {running ? (
          <button
            type="button"
            className="elves-agentbox__btn elves-agentbox__btn--cancel"
            data-testid="agent-cancel"
            onClick={cancel}
          >
            Cancel
          </button>
        ) : (
          <button
            type="button"
            className="elves-agentbox__btn elves-agentbox__btn--send"
            data-testid="agent-send"
            onClick={submit}
            disabled={!prompt.trim() || !projectId}
            title="Send (Enter)"
            aria-label="Send"
          >
            <PaperPlaneRight aria-hidden="true" weight="fill" />
          </button>
        )}
      </div>
    </div>
  )
}
