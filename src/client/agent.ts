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
  /** Suppress callbacks while continuing fail-closed cancellation/observation. */
  suppressCallbacks: () => void
  /** Detach all lifecycle work during component/application unmount. */
  dispose: () => void
  /** Resolves after authoritative inactivity, or immediately when detached. */
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
  let callbacksSuppressed = false
  let detached = false
  const emit = (event: AgentEvent) => {
    if (!callbacksSuppressed) onEvent(event)
  }
  let cancelRequested = false
  const prepareController = new AbortController()
  const runController = new AbortController()
  const lifecycleController = new AbortController()
  const preparation = (async () => {
    try {
      await prepareRun(runId, input.projectId, prepareController.signal)
      return true
    } catch (error) {
      if (!cancelRequested && !detached) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'the agent run could not be prepared' })
      }
      return false
    }
  })()
  let abandonRequest: Promise<void> | null = null
  let detachedAbandonRequest: Promise<void> | null = null
  const requestAbandon = () => {
    cancelRequested = true
    prepareController.abort()
    runController.abort()
    if (detached) {
      return detachedAbandonRequest ??= abandonOnceBestEffort(runId)
    }
    return abandonRequest ??= (async () => {
      await preparation
      await abandonRun(runId, lifecycleController.signal)
    })()
  }

  const done = (async () => {
    const prepared = await preparation
    if (detached) return
    if (cancelRequested) {
      try {
        await requestAbandon()
      } catch (error) {
        emit({ type: 'error', message: error instanceof Error ? error.message : 'the agent run could not be cancelled' })
      }
      return
    }
    if (!prepared) return
    let res: Response
    try {
      res = await fetch(`${BASE}/agent/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, runId }),
        signal: runController.signal,
      })
    } catch {
      if (detached) return
      if (cancelRequested) {
        try {
          await requestAbandon()
        } catch (error) {
          emit({ type: 'error', message: error instanceof Error ? error.message : 'the agent run could not be cancelled' })
        }
        await waitForRunToStop(runId, lifecycleController.signal)
        return
      }
      emit({ type: 'error', message: 'could not reach the server — is it running?' })
      await abandonAndWaitForRun(runId, lifecycleController.signal)
      return
    }
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
      // Validation/conflict 4xx responses are definite refusals. A 5xx or a
      // success missing its stream can be a lost accepted response, so settle
      // it through the same atomic abandon handshake as a fetch rejection.
      await abandonAndWaitForRun(runId, lifecycleController.signal)
      return
    }

    const reader = res.body.getReader()
    const detachReader = () => { void reader.cancel().catch(() => {}) }
    lifecycleController.signal.addEventListener('abort', detachReader, { once: true })
    const decoder = new TextDecoder()
    let buf = ''
    let sawEnd = false
    let reportedInterruption = false
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
          if (handleFrame(frame, emit)) sawEnd = true
        }
      }
    } catch {
      if (!cancelRequested) emit({ type: 'error', message: 'the agent stream was interrupted' })
      reportedInterruption = true
    } finally {
      lifecycleController.signal.removeEventListener('abort', detachReader)
    }
    if (detached) return
    if (!sawEnd) {
      // A response can truncate either with a reader error or a clean EOF. The
      // child deliberately survives that disconnect, so only its authoritative
      // status may release the UI's active-run lock.
      if (cancelRequested) {
        try {
          await requestAbandon()
        } catch (error) {
          emit({ type: 'error', message: error instanceof Error ? error.message : 'the agent run could not be cancelled' })
        }
      } else if (!reportedInterruption) {
        emit({ type: 'error', message: 'the agent stream was interrupted' })
      }
      await waitForRunToStop(runId, lifecycleController.signal)
    }
  })()

  return {
    runId,
    requestCancel: requestAbandon,
    suppressCallbacks: () => {
      callbacksSuppressed = true
    },
    dispose: () => {
      callbacksSuppressed = true
      detached = true
      lifecycleController.abort()
      prepareController.abort()
      runController.abort()
    },
    done,
  }
}

/**
 * Parse one SSE frame. A `data:` line carries a JSON {@link AgentEvent}; the
 * terminal `event: end` frame carries none and returns `true`; it is the proof
 * of normal completion that lets callers avoid authoritative status polling.
 */
function handleFrame(frame: string, onEvent: (e: AgentEvent) => void): boolean {
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    // The terminal `event: end` frame carries only a placeholder `data: {}` —
    // ignore the whole frame so it never dispatches a typeless event.
    if (line.startsWith('event:') && line.slice(6).trim() === 'end') return true
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (!dataLines.length) return false
  try {
    const parsed = JSON.parse(dataLines.join('\n'))
    // Guard against any stray frame: a real event always has a string `type`.
    if (parsed && typeof parsed.type === 'string') onEvent(parsed as AgentEvent)
  } catch {
    /* a malformed frame is dropped, never thrown */
  }
  return false
}

async function waitForRunToStop(runId: string, signal: AbortSignal): Promise<void> {
  let delayMs = 250
  while (!signal.aborted) {
    try {
      const response = await fetch(`${BASE}/agent/runs/${encodeURIComponent(runId)}`, {
        cache: 'no-store',
        signal,
      })
      if (response.ok) {
        const status = await response.json()
        if (status?.active === false) return
        if (status?.active === true) delayMs = 250
      }
    } catch {
      if (signal.aborted) return
      // A transient status failure must not unlock project transitions.
    }
    try {
      await abortableDelay(delayMs, signal)
    } catch {
      return
    }
    delayMs = Math.min(delayMs * 2, 5_000)
  }
}

async function abandonAndWaitForRun(runId: string, signal: AbortSignal): Promise<void> {
  await abandonRun(runId, signal)
  await waitForRunToStop(runId, signal)
}

async function abandonRun(runId: string, signal: AbortSignal): Promise<void> {
  let delayMs = 250
  while (!signal.aborted) {
    let response: Response
    try {
      response = await fetch(`${BASE}/agent/abandon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId }),
        signal,
      })
    } catch {
      if (signal.aborted) return
      // Retry with the same run id until late admission is atomically excluded.
      try {
        await abortableDelay(delayMs, signal)
      } catch {
        return
      }
      delayMs = Math.min(delayMs * 2, 5_000)
      continue
    }
    if (response.ok) return
    if (response.status < 500) {
      let message = `the run could not be cancelled (${response.status})`
      try {
        const body = await response.json()
        if (body?.error) message = body.error
      } catch {
        // Keep the status-code message.
      }
      throw new Error(message)
    }
    try {
      await abortableDelay(delayMs, signal)
    } catch {
      return
    }
    delayMs = Math.min(delayMs * 2, 5_000)
  }
}

function abandonOnceBestEffort(runId: string): Promise<void> {
  void fetch(`${BASE}/agent/abandon`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runId }),
    keepalive: true,
  }).catch(() => {})
  return Promise.resolve()
}

async function prepareRun(runId: string, projectId: string, signal: AbortSignal): Promise<void> {
  let delayMs = 250
  for (;;) {
    let response: Response
    try {
      response = await fetch(`${BASE}/agent/prepare`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId, projectId }),
        signal,
      })
    } catch {
      if (signal.aborted) throw signal.reason
      await abortableDelay(delayMs, signal)
      delayMs = Math.min(delayMs * 2, 5_000)
      continue
    }
    if (response.ok) return
    if (response.status >= 500) {
      await abortableDelay(delayMs, signal)
      delayMs = Math.min(delayMs * 2, 5_000)
      continue
    }
    let message = `the agent run could not be prepared (${response.status})`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // Keep the status-code message.
    }
    throw new Error(message)
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
