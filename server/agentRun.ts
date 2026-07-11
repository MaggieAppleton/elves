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
 * Fresh run each time: no persistent session, no terminal attach. One run at a
 * time — a second request while one is active is refused.
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
      cmd: 'claude',
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
  kill(signal?: NodeJS.Signals): void
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
}

export interface AgentRunner {
  run(input: AgentRunInput, onEvent: (e: AgentEvent) => void): Promise<void>
  cancel(): void
  isRunning(): boolean
}

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
  let active: ChildLike | null = null

  return {
    isRunning: () => active !== null,
    cancel() {
      if (active) {
        active.kill('SIGTERM')
        active = null
      }
    },
    run(input, onEvent) {
      if (active) {
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

      active = child
      onEvent({ type: 'started' })

      // A terminal event (done/error) may come from the parsed stream OR be
      // synthesized on close; either way, emit at most one so the box can't show
      // both a reply and an error for the same run.
      let sawTerminal = false
      const emit = (e: AgentEvent) => {
        if (e.type === 'done' || e.type === 'error') {
          if (sawTerminal) return
          sawTerminal = true
        }
        onEvent(e)
      }

      // stdout arrives in arbitrary chunks, not whole lines — buffer and split.
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
          active = null
          resolve()
        }
        child.on('error', (err) => {
          emit({ type: 'error', message: friendlySpawnError(cmd, err as NodeJS.ErrnoException) })
          finish()
        })
        child.on('close', (code) => {
          // Flush a trailing line the stream left unterminated.
          if (buf.trim()) for (const e of adapter.parseLine(buf)) emit(e)
          if (code === 0) emit({ type: 'done', reply: '' })
          else emit({ type: 'error', message: stderr.trim() || `\`${cmd}\` exited with code ${code}.` })
          finish()
        })
      })
    },
  }
}
