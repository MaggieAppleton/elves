import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Broom, CaretDown, Check, PaperPlaneRight } from '@phosphor-icons/react'
import { agentInfo } from '../shapes/agents'
import { runAgent, type AgentEvent, type AgentRunHandle } from '../client/agent'
import { deriveStatus } from '../client/agentStatus'
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

type RunPhase = 'idle' | 'running' | 'cancelling'

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
  const [runPhase, setRunPhase] = useState<RunPhase>('idle')
  const running = runPhase !== 'idle'
  // Whether the box is shrunk to the status bar. A fresh open always starts
  // expanded (see the focus effect); collapsing is conditional (see collapse).
  const [collapsed, setCollapsed] = useState(false)
  const handleRef = useRef<AgentRunHandle | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // The run outlives a hidden box, but not the component itself. Detach first
  // so late stream settlement cannot update an unmounted component, then stop
  // callbacks and ask the server to terminate the child process.
  useEffect(() => () => {
    const handle = handleRef.current
    handleRef.current = null
    if (!handle) return
    handle.dispose()
    void handle.requestCancel().catch(() => {})
  }, [])

  // A fresh open expands to the full box and focuses the field (after paint, so
  // the freshly-shown element is focusable).
  useEffect(() => {
    if (!open) return
    setCollapsed(false)
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  // Esc collapses (the safe, non-destructive hide). Capture-phase +
  // stopPropagation so tldraw's own Escape handler (deselect) doesn't also fire
  // underneath the open box. entries.length/running are in the deps so the
  // handler always sees whether there's a run worth preserving.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        collapse()
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, entries.length, running])

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

  // Collapse to the status bar — but only when there's a run or transcript worth
  // keeping. An idle box (nothing typed, nothing run) has nothing to preserve, so
  // collapsing it just closes it; an empty bar would be meaningless.
  const collapse = () => {
    if (entries.length > 0 || running) setCollapsed(true)
    else onClose()
  }

  const submit = () => {
    const text = prompt.trim()
    if (!text || running || !projectId) return
    setCollapsed(false)
    setPrompt('')
    // Seed the transcript with the user's message so it stays pinned above the
    // tool calls and replies that follow.
    setEntries([{ kind: 'user', text }])
    setRunPhase('running')
    const handle = runAgent({ prompt: text, projectId, hasSelection }, (e) => {
      setEntries((prev) => appendEvent(prev, e))
    })
    handleRef.current = handle
    void handle.done.then(() => {
      if (handleRef.current !== handle) return
      handleRef.current = null
      setRunPhase('idle')
    })
  }

  const cancel = () => {
    if (runPhase !== 'running') return
    const handle = handleRef.current
    if (!handle) return
    setRunPhase('cancelling')
    void handle.requestCancel().catch((err) => {
      if (handleRef.current !== handle) return
      setEntries((prev) => [...prev, {
        kind: 'error',
        message: err instanceof Error ? err.message : 'the run could not be cancelled',
      }])
      setRunPhase('running')
    })
  }

  // Close and forget: cancel any in-flight run, empty the transcript and
  // input, then close — unlike plain close, which preserves the chat.
  const closeAndClear = () => {
    const handle = handleRef.current
    handle?.dispose()
    if (handle) {
      setRunPhase('cancelling')
      void handle.requestCancel().catch((err) => {
        if (handleRef.current !== handle) return
        setEntries([{
          kind: 'error',
          message: err instanceof Error ? err.message : 'the run could not be cancelled',
        }])
        setRunPhase('running')
      })
    } else {
      setRunPhase('idle')
    }
    setEntries([])
    setPrompt('')
    setCollapsed(false)
    onClose()
  }

  if (!open) return null

  // Collapsed: render the status bar in place of the full box. It shows what the
  // agent is doing (or that it's done) and expands back on click. The run keeps
  // going underneath — collapsing never cancels.
  if (collapsed) {
    const status = runPhase === 'cancelling'
      ? { phase: 'thinking' as const, verb: 'Cancelling' }
      : deriveStatus(entries, running)
    const settled = status.phase === 'done' || status.phase === 'error'
    return (
      <button
        type="button"
        className="elves-agentbox--collapsed"
        data-phase={status.phase}
        data-testid="agent-collapsed"
        onClick={() => setCollapsed(false)}
        title="Expand"
        aria-label="Expand agent"
      >
        {status.phase === 'done' ? (
          <Check className="elves-agentbox__cicon" weight="bold" aria-hidden="true" />
        ) : (
          <span className="elves-agentbox__cdot" aria-hidden="true" />
        )}
        <span className="elves-agentbox__cverb" aria-live="polite">
          {status.verb}
        </span>
        {status.detail && <span className="elves-agentbox__cdetail">· {status.detail}</span>}
        {settled && <span className="elves-agentbox__chint">click to view</span>}
      </button>
    )
  }

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
          <button
            className="elves-agentbox__close"
            onClick={collapse}
            title="Collapse (Esc)"
            aria-label="Collapse"
            data-testid="agent-collapse"
          >
            <CaretDown aria-hidden="true" />
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
          disabled={runPhase === 'cancelling'}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {runPhase !== 'idle' ? (
          <button
            type="button"
            className="elves-agentbox__btn elves-agentbox__btn--cancel"
            data-testid="agent-cancel"
            onClick={cancel}
            disabled={runPhase === 'cancelling'}
          >
            {runPhase === 'cancelling' ? 'Cancelling…' : 'Cancel'}
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
