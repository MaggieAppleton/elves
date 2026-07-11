import { describe, expect, test } from 'vitest'
import {
  parseClaudeLine,
  buildPreamble,
  friendlyToolName,
  summarizeToolInput,
  claudeAdapter,
  createAgentRunner,
  resolveAdapter,
  type AgentEvent,
  type ChildLike,
} from '../../server/agentRun'

// --- Pure parsing ---------------------------------------------------------

describe('parseClaudeLine', () => {
  test('an assistant text block becomes a text event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Here is a better phrasing.' }] },
    })
    expect(parseClaudeLine(line)).toEqual([{ type: 'text', text: 'Here is a better phrasing.' }])
  })

  test('a tool_use block becomes a tool event with the namespace stripped', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'mcp__elves__read_selection', input: { project: 'p' } }],
      },
    })
    expect(parseClaudeLine(line)).toEqual([{ type: 'tool', name: 'read_selection', summary: '' }])
  })

  test('a text and a tool_use in one turn yield both events, in order', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Grouping these.' },
          { type: 'tool_use', name: 'mcp__elves__move_cards', input: { cardIds: ['a', 'b', 'c'] } },
        ],
      },
    })
    expect(parseClaudeLine(line)).toEqual([
      { type: 'text', text: 'Grouping these.' },
      { type: 'tool', name: 'move_cards', summary: '3 cards' },
    ])
  })

  test('a successful result becomes a done event carrying the final reply', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done — grouped into 3 sections.' })
    expect(parseClaudeLine(line)).toEqual([{ type: 'done', reply: 'Done — grouped into 3 sections.' }])
  })

  test('an error result becomes an error event', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'rate limited' })
    expect(parseClaudeLine(line)).toEqual([{ type: 'error', message: 'rate limited' }])
  })

  test('empty and non-JSON lines are ignored, not thrown', () => {
    expect(parseClaudeLine('')).toEqual([])
    expect(parseClaudeLine('   ')).toEqual([])
    expect(parseClaudeLine('not json at all')).toEqual([])
    expect(parseClaudeLine('{ half an object')).toEqual([])
  })

  test('system/init and tool_result lines carry nothing the box shows', () => {
    expect(parseClaudeLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([])
    expect(
      parseClaudeLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } })),
    ).toEqual([])
  })

  test('an empty assistant text block is dropped (no blank transcript line)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })
    expect(parseClaudeLine(line)).toEqual([])
  })
})

describe('helpers', () => {
  test('friendlyToolName strips only the elves prefix', () => {
    expect(friendlyToolName('mcp__elves__add_comment')).toBe('add_comment')
    expect(friendlyToolName('WebSearch')).toBe('WebSearch')
  })

  test('summarizeToolInput describes common argument shapes', () => {
    expect(summarizeToolInput({ cardIds: ['a', 'b'] })).toBe('2 cards')
    expect(summarizeToolInput({ ids: ['a'] })).toBe('1 card')
    expect(summarizeToolInput({ card: 'card:xyz' })).toBe('card:xyz')
    expect(summarizeToolInput({ query: 'spaced repetition' })).toBe('spaced repetition')
    expect(summarizeToolInput({})).toBe('')
    expect(summarizeToolInput(null)).toBe('')
  })

  test('buildPreamble names the project and steers scope by selection', () => {
    expect(buildPreamble('my-essay', true)).toContain('my-essay')
    expect(buildPreamble('my-essay', true)).toContain('read_selection')
    expect(buildPreamble('my-essay', false)).toContain('read_map')
  })
})

describe('claudeAdapter.buildCommand', () => {
  test('assembles the headless invocation with safety flags', () => {
    const { cmd, args } = claudeAdapter.buildCommand(
      { prompt: 'critique this card', projectId: 'p1', hasSelection: true },
      { mcpConfigPath: '/repo/.mcp.json', allowedTools: ['mcp__elves__*', 'WebSearch'], disallowedTools: ['Bash'] },
    )
    expect(cmd).toBe('claude')
    // The prompt is passed as its own arg (no shell), never interpolated.
    expect(args).toContain('critique this card')
    expect(args).toContain('-p')
    expect(args.join(' ')).toContain('--output-format stream-json')
    // Auto-approval must be present or a headless run hangs on the permission prompt.
    expect(args).toContain('--permission-mode')
    expect(args).toContain('dontAsk')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('/repo/.mcp.json')
    expect(args).toContain('mcp__elves__*,WebSearch')
    expect(args).toContain('Bash')
  })
})

describe('resolveAdapter', () => {
  test('claude resolves; unknown CLIs do not (surfaced as a clear error)', () => {
    expect(resolveAdapter('claude')).toBe(claudeAdapter)
    expect(resolveAdapter('codex')).toBeNull()
    expect(resolveAdapter('copilot')).toBeNull()
  })
})

// --- Runner orchestration (injected fake spawn) ---------------------------

// A hand-rolled ChildProcess stand-in: drive stdout/stderr/close from the test.
class FakeChild implements ChildLike {
  private dataCbs: ((c: Buffer | string) => void)[] = []
  private errDataCbs: ((c: Buffer | string) => void)[] = []
  private errCbs: ((e: Error) => void)[] = []
  private closeCbs: ((code: number | null) => void)[] = []
  killed: string | null = null
  stdout = { on: (_ev: 'data', cb: (c: Buffer | string) => void) => this.dataCbs.push(cb) }
  stderr = { on: (_ev: 'data', cb: (c: Buffer | string) => void) => this.errDataCbs.push(cb) }
  on(ev: 'error' | 'close', cb: any) {
    if (ev === 'error') this.errCbs.push(cb)
    else this.closeCbs.push(cb)
  }
  kill(signal?: string) {
    this.killed = signal ?? 'SIGTERM'
  }
  emitStdout(s: string) {
    for (const cb of this.dataCbs) cb(s)
  }
  emitStderr(s: string) {
    for (const cb of this.errDataCbs) cb(s)
  }
  emitError(err: Error) {
    for (const cb of this.errCbs) cb(err)
  }
  emitClose(code: number | null) {
    for (const cb of this.closeCbs) cb(code)
  }
}

const deps = (spawn: any) => ({ mcpConfigPath: '/repo/.mcp.json', cwd: '/repo', spawn })

test('a run streams started, then parsed events, then done', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const done = runner.run({ prompt: 'dedupe', projectId: 'p', hasSelection: false }, (e) => events.push(e))

  expect(runner.isRunning()).toBe(true)
  // Chunk arrives split across a line boundary — the runner must buffer and join.
  child.emitStdout('{"type":"assistant","message":{"content":[{"type":"text","text":"Merging duplicates."}]}}\n{"type":"assis')
  child.emitStdout('tant","message":{"content":[{"type":"tool_use","name":"mcp__elves__merge_notes","input":{"cardIds":["a","b"]}}]}}\n')
  child.emitStdout('{"type":"result","subtype":"success","result":"Merged 2 notes."}\n')
  child.emitClose(0)
  await done

  expect(events).toEqual([
    { type: 'started' },
    { type: 'text', text: 'Merging duplicates.' },
    { type: 'tool', name: 'merge_notes', summary: '2 cards' },
    { type: 'done', reply: 'Merged 2 notes.' },
  ])
  expect(runner.isRunning()).toBe(false)
})

test('a second run while one is active is refused', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const first = runner.run({ prompt: 'a', projectId: 'p', hasSelection: false }, () => {})

  const second: AgentEvent[] = []
  await runner.run({ prompt: 'b', projectId: 'p', hasSelection: false }, (e) => second.push(e))
  expect(second).toEqual([{ type: 'error', message: expect.stringContaining('already running') }])

  child.emitClose(0)
  await first
})

test('cancel kills the child', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const run = runner.run({ prompt: 'a', projectId: 'p', hasSelection: false }, () => {})
  runner.cancel()
  expect(child.killed).toBe('SIGTERM')
  expect(runner.isRunning()).toBe(false)
  child.emitClose(null)
  await run
})

test('a nonzero exit with no result line becomes an error from stderr', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const done = runner.run({ prompt: 'a', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  child.emitStderr('boom: something failed')
  child.emitClose(1)
  await done
  expect(events).toEqual([{ type: 'started' }, { type: 'error', message: 'boom: something failed' }])
})

test('an ENOENT thrown synchronously by spawn is reported, not crashed', async () => {
  const runner = createAgentRunner(
    deps(() => {
      const err: NodeJS.ErrnoException = new Error('spawn claude ENOENT')
      err.code = 'ENOENT'
      throw err
    }),
  )
  const events: AgentEvent[] = []
  await runner.run({ prompt: 'a', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('not installed') }])
  expect(runner.isRunning()).toBe(false)
})

test('an unsupported ELVES_CLI is rejected with a clear message', async () => {
  const runner = createAgentRunner({ mcpConfigPath: '/repo/.mcp.json', cwd: '/repo', cliName: 'codex', spawn: () => new FakeChild() })
  const events: AgentEvent[] = []
  await runner.run({ prompt: 'a', projectId: 'p', hasSelection: false }, (e) => events.push(e))
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('not supported yet') }])
})
