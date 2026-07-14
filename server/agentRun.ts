import { spawn as nodeSpawn } from 'node:child_process'

/**
 * Bridge from the in-app chat box to a headless agent CLI.
 *
 * When the user presses `/` and types a request, the browser POSTs it here; the
 * server spawns the configured CLI (`ELVES_CLI`, default `claude`) as a one-shot
 * child process, wired to the same scoped `elves` MCP server a terminal agent
 * uses. The child does its work on the canvas THROUGH the MCP (so its changes
 * flow back over the existing realtime WS and glow live), while its own
 * reasoning + tool calls stream out here as normalized {@link AgentEvent}s that
 * the box renders as a transcript.
 *
 * Fresh run each time: no persistent session, no terminal attach. Runs are keyed
 * by caller (the chat box uses `'chat'`, a review run uses `review:<reviewId>`):
 * a given key is single-flight — a second request under the SAME key while one
 * is active is refused — but different keys run concurrently, so a chat run and
 * one or more review runs can all be in flight at once.
 *
 * Safety: the child is locked to the elves MCP tools plus read-only web
 * (WebSearch/WebFetch) and explicitly denied shell/file tools, so its blast
 * radius is "the canvas, minus your prose" (the MCP server itself forbids
 * writing prose) — the same as a terminal agent, just triggered from the app.
 */

/** A normalized event the client renders. The client never parses vendor JSON —
 * every CLI adapter maps its own stream format onto this small contract. */
export type AgentEvent =
  | { type: 'started' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'done'; reply: string }
  | { type: 'error'; message: string }

export interface AgentRunInput {
  runId: string
  prompt: string
  projectId: string
  /** True when the user has cards selected — steers the preamble toward
   * read_selection (scope to those) vs read_map (the whole canvas). */
  hasSelection: boolean
}

// The agent gets full canvas powers (all elves MCP tools) plus read-only web,
// and nothing else. `mcp__<server>__*` allows every tool from that server.
// Denied tools are named explicitly as defense-in-depth so a future CLI default
// that auto-allows them can't widen the blast radius.
const ALLOWED_TOOLS = ['mcp__elves__*', 'WebSearch', 'WebFetch']
const DISALLOWED_TOOLS = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// Headless, no-TTY mode: listing tools in --allowedTools is NOT enough to skip
// approval prompts — without a permission mode the child hangs waiting for a
// terminal that never comes. `dontAsk` auto-approves the allowlist and
// auto-DENIES everything else (never prompts), which is exactly the safety
// posture we want: full canvas powers, nothing else, no hang.
const PERMISSION_MODE = 'dontAsk'

/** The only app-specific knowledge the CLI can't infer: which project this is,
 * and whether to scope to the current selection or the whole canvas. House
 * rules (one sentence; never write prose) are NOT restated — the elves MCP
 * server injects those to every agent that connects, in the initialize
 * handshake, so a headless run inherits them for free. */
export function buildPreamble(projectId: string, hasSelection: boolean): string {
  const scope = hasSelection
    ? 'The user has cards selected on the canvas — call read_selection to see them and scope your work to those cards.'
    : 'The user has nothing selected — call read_map to see the whole canvas and work across it.'
  return `You are running inside the Elves app, triggered from the canvas by the user. Operate on the project with id "${projectId}". ${scope}`
}

const ELVES_TOOL_PREFIX = 'mcp__elves__'

/** Strip the MCP namespace so the transcript reads `read_selection`, not
 * `mcp__elves__read_selection`. Non-MCP tools (WebSearch) pass through. */
export function friendlyToolName(rawName: string): string {
  return rawName.startsWith(ELVES_TOOL_PREFIX) ? rawName.slice(ELVES_TOOL_PREFIX.length) : rawName
}

/** A short, human summary of a tool call's arguments for the transcript line —
 * "3 cards", a card id, a search query. Deliberately modest; the client
 * prettifies further (Slice 3). Empty string when there's nothing worth
 * showing. */
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const count = (ids: unknown) => (Array.isArray(ids) ? `${ids.length} card${ids.length === 1 ? '' : 's'}` : '')
  if (Array.isArray(o.cardIds)) return count(o.cardIds)
  if (Array.isArray(o.ids)) return count(o.ids)
  if (typeof o.card === 'string') return o.card
  if (typeof o.query === 'string') return o.query
  if (typeof o.url === 'string') return o.url
  return ''
}

/** Parse one line of `claude --output-format stream-json` stdout into zero or
 * more normalized events. Non-JSON or unrecognized lines yield nothing (partial
 * chunks, init noise) rather than throwing — a malformed line must never abort
 * a run. Each stdout line is one JSON object:
 *  - `assistant` — a model turn; its `message.content[]` holds `text` blocks
 *    (the agent's prose) and `tool_use` blocks (name + input).
 *  - `result` — the terminal line; `result` is the final reply text, and
 *    `is_error` marks a failed run.
 * `system`/`user` lines (init, tool results) carry nothing the box shows. */
export function parseClaudeLine(line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let obj: any
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!obj || typeof obj !== 'object') return []
  switch (obj.type) {
    case 'assistant': {
      const content = obj.message?.content
      if (!Array.isArray(content)) return []
      const events: AgentEvent[] = []
      for (const block of content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          events.push({ type: 'text', text: block.text })
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          events.push({
            type: 'tool',
            name: friendlyToolName(block.name),
            summary: summarizeToolInput(block.input),
          })
        }
      }
      return events
    }
    case 'result': {
      if (obj.is_error) {
        return [{ type: 'error', message: typeof obj.result === 'string' ? obj.result : 'the agent run failed' }]
      }
      return [{ type: 'done', reply: typeof obj.result === 'string' ? obj.result : '' }]
    }
    default:
      return []
  }
}

/** How to invoke and parse one CLI. Swapping this is how we support codex /
 * copilot later — the runner stays identical. */
export interface CliAdapter {
  buildCommand(
    input: AgentRunInput,
    ctx: { mcpConfigPath: string; allowedTools: string[]; disallowedTools: string[] },
  ): { cmd: string; args: string[] }
  parseLine(line: string): AgentEvent[]
}

export const claudeAdapter: CliAdapter = {
  buildCommand(input, ctx) {
    return {
      // ELVES_CLI_BIN overrides the actual binary invoked (default `claude`) —
      // lets e2e point this at a deterministic stub, or a real `claude` living
      // at a nonstandard path, without touching adapter selection (ELVES_CLI).
      cmd: process.env.ELVES_CLI_BIN || 'claude',
      args: [
        '-p',
        input.prompt,
        '--output-format',
        'stream-json',
        // stream-json in print mode requires --verbose to emit per-turn events.
        '--verbose',
        '--append-system-prompt',
        buildPreamble(input.projectId, input.hasSelection),
        // Use ONLY the elves server from this config (--strict-mcp-config), so
        // the child never picks up the user's global/other MCP servers — it gets
        // the canvas and nothing else.
        '--mcp-config',
        ctx.mcpConfigPath,
        '--strict-mcp-config',
        // Auto-approve the allowlist, auto-deny the rest, never prompt (no TTY).
        '--permission-mode',
        PERMISSION_MODE,
        // Comma-separated allow/deny lists. `mcp__elves__*` allows every tool the
        // elves server exposes; the deny list is belt-and-suspenders.
        '--allowedTools',
        ctx.allowedTools.join(','),
        '--disallowedTools',
        ctx.disallowedTools.join(','),
      ],
    }
  },
  parseLine: parseClaudeLine,
}

/** v1 ships the claude adapter fully; codex/copilot are recognized names but
 * not yet wired — resolve returns null so the route surfaces a clear message
 * rather than spawning a mystery binary. */
export function resolveAdapter(cliName: string): CliAdapter | null {
  return cliName === 'claude' ? claudeAdapter : null
}

// The subset of a Node ChildProcess the runner needs — narrowed so a test can
// pass a hand-rolled fake without a real process.
export interface ChildLike {
  stdout: { on(ev: 'data', cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(ev: 'data', cb: (chunk: Buffer | string) => void): void } | null
  on(ev: 'error', cb: (err: Error) => void): void
  on(ev: 'close', cb: (code: number | null) => void): void
  kill(signal?: NodeJS.Signals): boolean
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike

export interface AgentRunnerDeps {
  /** Absolute path to the .mcp.json defining the `elves` server. */
  mcpConfigPath: string
  /** cwd for the child, so its `mcp/index.ts` (relative in .mcp.json) resolves. */
  cwd: string
  /** `ELVES_CLI` — which CLI to drive. Defaults to `claude`. */
  cliName?: string
  /** Injectable for tests; defaults to node:child_process spawn. */
  spawn?: SpawnFn
  /** Grace period before an ignored SIGTERM escalates to SIGKILL. */
  cancelGraceMs?: number
  /** Injectable monotonic-ish clock for bounded abandonment tombstones. */
  nowMs?: () => number
  tombstoneTtlMs?: number
  tombstoneLimit?: number
}

export interface AgentRunReservation {
  readonly projectId: string
}

export interface AgentRunner {
  run(key: string, input: AgentRunInput, onEvent: (e: AgentEvent) => void): Promise<void>
  cancel(key: string, runId: string): AgentCancelResult
  isRunning(key: string, runId?: string): boolean
  isProjectRunning(projectId: string): boolean
  reserveProjectRun(projectId: string, key?: string, runId?: string): AgentRunReservation | null
  isRunAdmitted(key: string, runId: string): boolean
  runReserved(
    reservation: AgentRunReservation,
    key: string,
    input: AgentRunInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void>
  releaseProjectRun(reservation: AgentRunReservation): void
  abandon(key: string, runId: string): AgentAbandonResult
  cancelAndWait(key: string, runId: string): Promise<AgentCancelResult>
  /** Atomically exclude new runs for a project while a structural transition runs. */
  tryLockProject(projectId: string): (() => void) | null
}

export type AgentCancelResult =
  | { status: 'accepted' }
  | { status: 'not-running' }
  | { status: 'run-mismatch' }
  | { status: 'signal-failed' }

export type AgentAbandonResult = AgentCancelResult | { status: 'prevented' }

/** ENOENT means the CLI isn't installed / not on PATH — the single most likely
 * failure, so name it plainly instead of leaking a raw errno. */
function friendlySpawnError(cmd: string, err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOENT') {
    return `\`${cmd}\` is not installed or not on PATH — install it (or set ELVES_CLI) to run agents from the app.`
  }
  return `could not start \`${cmd}\`: ${err.message}`
}

export function createAgentRunner(deps: AgentRunnerDeps): AgentRunner {
  const spawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn)
  const cliName = deps.cliName ?? 'claude'
  // Concurrent runs, keyed by caller: 'chat' for the chat box, 'review:<id>'
  // for an in-app review run. A key is single-flight (see run() below); across
  // keys there's no coordination at all — that's the whole point of the map.
  const active = new Map<string, {
    runId: string
    projectId: string
    child: ChildLike
    stopped: Promise<void>
    resolveStopped: () => void
  }>()
  const projectLocks = new Map<string, symbol>()
  const reservationTokens = new WeakMap<AgentRunReservation, symbol>()
  const reservations = new Map<symbol, { projectId: string; key?: string; runId?: string }>()
  const tombstones = new Map<string, number>()
  const cancelled = new WeakSet<ChildLike>()
  const cancelGraceMs = deps.cancelGraceMs ?? 5_000
  const nowMs = deps.nowMs ?? Date.now
  const tombstoneTtlMs = deps.tombstoneTtlMs ?? 10 * 60_000
  const tombstoneLimit = deps.tombstoneLimit ?? 1_024

  const tombstoneKey = (key: string, runId: string) => `${key}\0${runId}`
  const pruneTombstones = () => {
    const now = nowMs()
    for (const [key, expiresAt] of tombstones) {
      if (expiresAt <= now) tombstones.delete(key)
    }
    while (tombstones.size >= tombstoneLimit) {
      const oldest = tombstones.keys().next().value as string | undefined
      if (oldest === undefined) break
      tombstones.delete(oldest)
    }
  }
  const installTombstone = (key: string, runId: string) => {
    pruneTombstones()
    tombstones.set(tombstoneKey(key, runId), nowMs() + tombstoneTtlMs)
  }
  const isTombstoned = (key: string, runId: string) => {
    pruneTombstones()
    return tombstones.has(tombstoneKey(key, runId))
  }

  const reserveProjectRun = (projectId: string, key?: string, runId?: string): AgentRunReservation | null => {
    if (projectLocks.has(projectId)) return null
    if (key && (active.has(key) || [...reservations.values()].some((entry) => entry.key === key))) return null
    const reservation = Object.freeze({ projectId })
    const token = Symbol(projectId)
    reservationTokens.set(reservation, token)
    reservations.set(token, { projectId, key, runId })
    return reservation
  }

  const releaseProjectRun = (reservation: AgentRunReservation) => {
    const token = reservationTokens.get(reservation)
    if (token) reservations.delete(token)
  }

  const signalCancel = (key: string, runId: string): AgentCancelResult => {
    const current = active.get(key)
    if (!current) return { status: 'not-running' }
    if (current.runId !== runId) return { status: 'run-mismatch' }
    try {
      if (!current.child.kill('SIGTERM')) return { status: 'signal-failed' }
    } catch {
      return { status: 'signal-failed' }
    }
    cancelled.add(current.child)
    return { status: 'accepted' }
  }

  const runReserved = (
    reservation: AgentRunReservation,
    key: string,
    input: AgentRunInput,
    onEvent: (e: AgentEvent) => void,
  ): Promise<void> => {
    const token = reservationTokens.get(reservation)
    const held = token ? reservations.get(token) : undefined
    if (!held || held.projectId !== input.projectId ||
      (held.key !== undefined && held.key !== key) ||
      (held.runId !== undefined && held.runId !== input.runId)) {
      onEvent({ type: 'error', message: 'the agent run reservation is no longer valid.' })
      return Promise.resolve()
    }
    if (isTombstoned(key, input.runId)) {
      onEvent({ type: 'error', message: 'the agent run was abandoned before it could start.' })
      return Promise.resolve()
    }
    if (active.has(key)) {
      onEvent({ type: 'error', message: 'an agent is already running — wait for it to finish or cancel it.' })
      return Promise.resolve()
    }
    const adapter = resolveAdapter(cliName)
    if (!adapter) {
      onEvent({
        type: 'error',
        message: `ELVES_CLI="${cliName}" is not supported yet — v1 supports "claude".`,
      })
      return Promise.resolve()
    }
    const { cmd, args } = adapter.buildCommand(input, {
      mcpConfigPath: deps.mcpConfigPath,
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
    })

    let child: ChildLike
    try {
      child = spawnFn(cmd, args, { cwd: deps.cwd, env: { ...process.env } })
    } catch (err) {
      onEvent({ type: 'error', message: friendlySpawnError(cmd, err as NodeJS.ErrnoException) })
      return Promise.resolve()
    }

    let resolveStopped!: () => void
    const stopped = new Promise<void>((resolve) => { resolveStopped = resolve })
    active.set(key, { runId: input.runId, projectId: input.projectId, child, stopped, resolveStopped })
    onEvent({ type: 'started' })

    let sawTerminal = false
    const emit = (e: AgentEvent) => {
      if (e.type === 'done' || e.type === 'error') {
        if (sawTerminal) return
        sawTerminal = true
      }
      onEvent(e)
    }

    let buf = ''
    child.stdout?.on('data', (chunk) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        for (const e of adapter.parseLine(line)) emit(e)
      }
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    return new Promise<void>((resolve) => {
      const finish = () => {
        if (active.get(key)?.child === child) active.delete(key)
        resolveStopped()
        resolve()
      }
      child.on('error', (err) => {
        emit({ type: 'error', message: friendlySpawnError(cmd, err as NodeJS.ErrnoException) })
      })
      child.on('close', (code) => {
        if (buf.trim()) for (const e of adapter.parseLine(buf)) emit(e)
        if (cancelled.has(child)) emit({ type: 'done', reply: 'Cancelled.' })
        else if (code === 0) emit({ type: 'done', reply: '' })
        else emit({ type: 'error', message: stderr.trim() || `\`${cmd}\` exited with code ${code}.` })
        finish()
      })
    })
  }

  const runner: AgentRunner = {
    isRunning: (key, runId) => {
      const current = active.get(key)
      return !!current && (runId === undefined || current.runId === runId)
    },
    isProjectRunning: (projectId) =>
      [...active.values()].some((run) => run.projectId === projectId),
    reserveProjectRun,
    isRunAdmitted(key, runId) {
      if (active.get(key)?.runId === runId) return true
      return [...reservations.values()].some((entry) => entry.key === key && entry.runId === runId)
    },
    runReserved,
    releaseProjectRun,
    abandon(key, runId) {
      installTombstone(key, runId)
      const current = active.get(key)
      if (!current || current.runId !== runId) return { status: 'prevented' }
      return signalCancel(key, runId)
    },
    async cancelAndWait(key, runId) {
      installTombstone(key, runId)
      const current = active.get(key)
      const result = signalCancel(key, runId)
      if (result.status !== 'accepted' || !current) return result
      const escalation = setTimeout(() => {
        if (active.get(key)?.child !== current.child) return
        try {
          current.child.kill('SIGKILL')
        } catch {
          // Keep waiting for a truthful close; the caller must remain locked.
        }
      }, cancelGraceMs)
      await current.stopped
      clearTimeout(escalation)
      return result
    },
    tryLockProject(projectId) {
      if (projectLocks.has(projectId) ||
        [...reservations.values()].some((reservation) => reservation.projectId === projectId) ||
        [...active.values()].some((run) => run.projectId === projectId)) {
        return null
      }
      const token = Symbol(projectId)
      projectLocks.set(projectId, token)
      return () => {
        if (projectLocks.get(projectId) === token) projectLocks.delete(projectId)
      }
    },
    cancel(key, runId) {
      return signalCancel(key, runId)
    },
    run(key, input, onEvent) {
      if (active.has(key)) {
        onEvent({ type: 'error', message: 'an agent is already running — wait for it to finish or cancel it.' })
        return Promise.resolve()
      }
      const reservation = reserveProjectRun(input.projectId, key, input.runId)
      if (!reservation) {
        onEvent({ type: 'error', message: 'the project is changing — wait for it to finish before starting an agent.' })
        return Promise.resolve()
      }
      return runReserved(reservation, key, input, onEvent)
        .finally(() => releaseProjectRun(reservation))
    },
  }
  return runner
}
