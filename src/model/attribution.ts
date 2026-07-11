/**
 * Character-level authorship for a card's `text`.
 *
 * A card records not just its LAST writer (`authoredBy`) but WHO wrote each
 * stretch of its text, as a list of runs that concatenate to cover the text
 * exactly. `author` is either the sentinel `'user'` (the human) or an agent id
 * (e.g. `'claude'`), resolved for display through the author registry
 * (src/shapes/agents). The engine here is pure and view-agnostic: it maintains
 * the runs across edits so a later view layer can, e.g., highlight one author's
 * spans — that highlight is a pure read of this data, no engine change needed.
 *
 * INVARIANT: for a text of length N, sum(run.length) === N, runs are in text
 * order, no run is zero-length, and no two adjacent runs share an author.
 */
export type AttributionRun = { author: string; length: number }
export type Attribution = AttributionRun[]

/** The sentinel author id for human-written text (cards store `authoredBy: null`). */
export const USER_AUTHOR = 'user'

/** Longest shared prefix length of two strings. */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Longest shared suffix length of two strings, capped at `max` so a prefix and
 * suffix can never overlap the same character (which would double-count it).
 */
function commonSuffix(a: string, b: string, max: number): number {
  const n = Math.min(a.length, b.length, Math.max(0, max))
  let i = 0
  while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++
  return i
}

/**
 * The runs (splitting boundary runs as needed) covering the character range
 * [start, end) of the text `attr` describes. Empty range → no runs.
 */
function sliceRuns(attr: Attribution, start: number, end: number): Attribution {
  const out: Attribution = []
  if (end <= start) return out
  let pos = 0
  for (const run of attr) {
    const runStart = pos
    const runEnd = pos + run.length
    pos = runEnd
    const s = Math.max(start, runStart)
    const e = Math.min(end, runEnd)
    if (e > s) out.push({ author: run.author, length: e - s })
  }
  return out
}

/** Drop zero-length runs and merge adjacent same-author runs. */
function coalesce(attr: Attribution): Attribution {
  const out: Attribution = []
  for (const run of attr) {
    if (run.length <= 0) continue
    const last = out[out.length - 1]
    if (last && last.author === run.author) last.length += run.length
    else out.push({ author: run.author, length: run.length })
  }
  return out
}

/**
 * Coalesce runs and enforce the length invariant against `textLength`. If the
 * runs don't sum to the text length (corruption, a lost edit, a legacy shape),
 * fall back to a single `'user'` run of the correct length rather than render a
 * broken/partial attribution. `textLength` 0 → empty attribution.
 */
export function normalizeAttribution(attribution: Attribution | null, textLength: number): Attribution {
  if (textLength <= 0) return []
  const coalesced = coalesce(attribution ?? [])
  const sum = coalesced.reduce((n, r) => n + r.length, 0)
  if (sum !== textLength) return [{ author: USER_AUTHOR, length: textLength }]
  return coalesced
}

/**
 * Reattribute a card's text after an edit from `oldText` to `newText`, crediting
 * the changed span to `author`.
 *
 * Diffs by common prefix/suffix: the untouched head and tail keep their existing
 * authorship, and the single contiguous middle span that changed is attributed
 * to `author`. This is a single-region diff — it credits ONE contiguous edited
 * span per call, which matches how a textarea onChange or an agent's edit_card
 * replaces text. Two separated insertions in one call collapse into one span
 * (the whole range between the outermost changes) credited to `author`.
 *
 * A null `oldAttribution` (a legacy card, or one seeded before this field) is
 * treated as one `'user'` run over the old text.
 */
export function reattribute(
  oldText: string,
  newText: string,
  oldAttribution: Attribution | null,
  author: string,
): Attribution {
  const base = normalizeAttribution(oldAttribution, oldText.length)
  const p = commonPrefix(oldText, newText)
  const s = commonSuffix(oldText, newText, Math.min(oldText.length, newText.length) - p)
  const insertedLen = newText.length - s - p
  const prefixRuns = sliceRuns(base, 0, p)
  const middle: Attribution = insertedLen > 0 ? [{ author, length: insertedLen }] : []
  const suffixRuns = sliceRuns(base, oldText.length - s, oldText.length)
  const merged = coalesce([...prefixRuns, ...middle, ...suffixRuns])
  return normalizeAttribution(merged, newText.length)
}

/** Distinct authors of an attribution, in first-appearance (text) order. */
export function contributors(attribution: Attribution | null): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const run of attribution ?? []) {
    if (!seen.has(run.author)) {
      seen.add(run.author)
      out.push(run.author)
    }
  }
  return out
}
