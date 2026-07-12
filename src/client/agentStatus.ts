/**
 * Derives the one-line status shown on the collapsed agent bar from the live
 * transcript. Pure — it knows nothing about React or the bar's markup; it just
 * turns `(entries, running)` into `{ phase, verb, detail }`, and the bar renders
 * whatever comes back. That isolation means the verb table below can be retuned
 * without touching a line of rendering.
 */

/** The minimal shape of a transcript entry this module reads. `AgentBox`'s
 * richer `Entry` union is structurally assignable to it, so no types move and
 * there's no import cycle. */
export interface StatusEntry {
  kind: 'user' | 'text' | 'tool' | 'error'
  /** Present on tool entries — the namespace-stripped tool name. */
  name?: string
  /** Present on tool entries — the server's short arg summary ("3 cards"). */
  summary?: string
}

export type StatusPhase = 'thinking' | 'working' | 'done' | 'error'

export interface AgentStatus {
  phase: StatusPhase
  /** Present-tense label: "Reading", "Searching", "Thinking", "Done"… */
  verb: string
  /** Optional trailing detail, e.g. "3 cards" — reuses the tool's summary. */
  detail?: string
}

/**
 * Tool → present-tense verb, in priority order (first match wins). This table is
 * the subjective, tweakable heart of the status line — reorder or add rules
 * freely. Matching is on the lowercased, namespace-stripped tool name.
 */
const VERB_RULES: Array<[(name: string) => boolean, string]> = [
  [(n) => n.startsWith('read_') || n.startsWith('list_'), 'Reading'],
  [(n) => n.startsWith('create_'), 'Writing'],
  [(n) => n.startsWith('edit_'), 'Editing'],
  [(n) => n.startsWith('delete_'), 'Deleting'],
  [
    (n) =>
      n.startsWith('move_') ||
      n.startsWith('group_') ||
      n.startsWith('ungroup_') ||
      n.startsWith('merge_'),
    'Organising',
  ],
  [(n) => n.includes('review'), 'Reviewing'],
  [(n) => n.includes('comment'), 'Commenting'],
  [(n) => n.includes('search'), 'Searching'],
  [(n) => n === 'bash', 'Running'],
]

/** Fallback for an unmapped tool: "frobnicate_widgets" → "Frobnicate widgets". */
function humanise(toolName: string): string {
  const spaced = toolName.replace(/_/g, ' ').trim()
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : 'Working'
}

/** Map a tool name to the verb shown while it runs. */
export function verbFor(toolName: string): string {
  const name = toolName.toLowerCase()
  for (const [matches, verb] of VERB_RULES) {
    if (matches(name)) return verb
  }
  return humanise(toolName)
}

/**
 * Turn the transcript into a glanceable status:
 *  - running + a tool as the newest entry → that tool's verb + its summary,
 *  - running otherwise (user msg, agent prose, or nothing yet) → "Thinking",
 *  - finished with an error last → the error phase,
 *  - finished otherwise → "Done".
 */
export function deriveStatus(entries: StatusEntry[], running: boolean): AgentStatus {
  const last = entries[entries.length - 1]
  if (running) {
    if (last?.kind === 'tool') {
      return { phase: 'working', verb: verbFor(last.name ?? ''), detail: last.summary || undefined }
    }
    return { phase: 'thinking', verb: 'Thinking' }
  }
  if (last?.kind === 'error') return { phase: 'error', verb: 'Error' }
  return { phase: 'done', verb: 'Done' }
}
