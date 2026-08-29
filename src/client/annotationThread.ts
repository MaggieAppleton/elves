import type { AgentEvent } from '../../server/agentRun'
import type { AnnotationMessage } from '../model/types'

const BASE = (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199'

export type AnnotationThreadTarget =
  | { kind: 'card'; cardId: string; commentId: string }
  | { kind: 'feedback'; feedbackId: string }

export interface AnnotationThreadRun {
  readonly runId: string
  readonly done: Promise<void>
}

/** Persist the human turn first. Reusing this id is safe after an ambiguous retry. */
export async function persistAnnotationReply(
  projectId: string,
  target: AnnotationThreadTarget,
  message: AnnotationMessage,
): Promise<void> {
  if (!message.text.trim()) throw new Error('a reply cannot be empty')
  const response = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/changeset`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: `annotation-reply:${message.id}`,
      author: 'user',
      ops: [{ kind: 'append_annotation_message', target, message }],
    }),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(body?.error ?? `could not save reply (${response.status})`)
  }
}

/** Start a scoped run only after the matching user message is durable. */
export function runAnnotationThread(
  projectId: string,
  target: AnnotationThreadTarget,
  messageId: string,
  onEvent: (event: AgentEvent) => void,
): AnnotationThreadRun {
  const runId = crypto.randomUUID()
  const done = (async () => {
    const response = await fetch(`${BASE}/projects/${encodeURIComponent(projectId)}/annotations/run`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, messageId, runId }),
    })
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null)
      throw new Error(body?.error ?? `the annotation run could not start (${response.status})`)
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done: ended, value } = await reader.read()
      if (ended) break
      buffer += decoder.decode(value, { stream: true })
      let separator: number
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (frame.includes('event: end')) return
        const line = frame.split('\n').find((candidate) => candidate.startsWith('data:'))
        if (!line) continue
        try {
          const event = JSON.parse(line.slice(5).trim())
          if (event?.type) onEvent(event as AgentEvent)
        } catch { /* malformed progress never breaks a durable thread */ }
      }
    }
  })()
  return { runId, done }
}

/** The retry path calls only this function: it never persists a second user turn. */
export function retryAnnotationReply(
  projectId: string,
  target: AnnotationThreadTarget,
  persistedMessageId: string,
  onEvent: (event: AgentEvent) => void,
): AnnotationThreadRun {
  return runAnnotationThread(projectId, target, persistedMessageId, onEvent)
}
