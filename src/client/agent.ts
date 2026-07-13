import type { AgentEvent } from '../../server/agentRun'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export type { AgentEvent }

export interface AgentRunInput {
  prompt: string
  projectId: string
  hasSelection: boolean
}

export interface AgentRunHandle {
  readonly runId: string
  /** Tell the server to terminate the child while continuing to observe its stream. */
  requestCancel: () => Promise<void>
  /** Suppress callbacks while continuing to observe this stream's termination. */
  dispose: () => void
  /** Resolves when the server closes the stream. */
  done: Promise<void>
}

/**
 * Drive one agent run from the browser. POSTs the prompt to the server's SSE
 * endpoint and decodes the `data:`-framed {@link AgentEvent} stream, invoking
 * `onEvent` for each. We read the stream with fetch + a ReadableStream reader
 * rather than EventSource because EventSource can't POST a body.
 *
 * The agent's canvas edits arrive over the realtime WS as usual; this stream
 * carries only the transcript (its text + tool calls + final reply).
 */
export function runAgent(input: AgentRunInput, onEvent: (e: AgentEvent) => void): AgentRunHandle {
  const runId = crypto.randomUUID()
  let disposed = false
  const emit = (event: AgentEvent) => {
    if (!disposed) onEvent(event)
  }

  const done = (async () => {
    let res: Response
    try {
      res = await fetch(`${BASE}/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, runId }),
      })
    } catch {
      if (!disposed) emit({ type: 'error', message: 'could not reach the server — is it running?' })
      return
    }
    if (disposed) return

    if (!res.ok || !res.body) {
      // The server refused before streaming (400/409/501) — it answers JSON here.
      let message = `the run could not start (${res.status})`
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch {
        /* keep the status-code message */
      }
      emit({ type: 'error', message })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done: streamDone, value } = await reader.read()
        if (streamDone) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line.
        let sep: number
        while ((sep = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          handleFrame(frame, emit)
        }
      }
    } catch {
      if (!disposed) emit({ type: 'error', message: 'the agent stream was interrupted' })
    }
  })()

  return {
    runId,
    requestCancel: async () => {
      let res: Response
      try {
        res = await fetch(`${BASE}/agent/cancel`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId }),
        })
      } catch {
        throw new Error('could not reach the server to cancel the agent run')
      }
      if (res.ok) return
      let message = `the run could not be cancelled (${res.status})`
      try {
        const body = await res.json()
        if (body?.error) message = body.error
      } catch {
        /* keep the status-code message */
      }
      throw new Error(message)
    },
    dispose: () => {
      disposed = true
    },
    done,
  }
}

/**
 * Parse one SSE frame. A `data:` line carries a JSON {@link AgentEvent}; the
 * terminal `event: end` frame carries none and is ignored (the reader's own
 * end-of-stream is the real signal callers wait on).
 */
function handleFrame(frame: string, onEvent: (e: AgentEvent) => void): void {
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    // The terminal `event: end` frame carries only a placeholder `data: {}` —
    // ignore the whole frame so it never dispatches a typeless event.
    if (line.startsWith('event:') && line.slice(6).trim() === 'end') return
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return
  try {
    const parsed = JSON.parse(dataLines.join('\n'))
    // Guard against any stray frame: a real event always has a string `type`.
    if (parsed && typeof parsed.type === 'string') onEvent(parsed as AgentEvent)
  } catch {
    /* a malformed frame is dropped, never thrown */
  }
}
