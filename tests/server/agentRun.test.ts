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
      { runId: 'run-a', prompt: 'critique this card', projectId: 'p1', hasSelection: true },
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
  killResult = true
  killError: Error | null = null
  stdout = { on: (_ev: 'data', cb: (c: Buffer | string) => void) => this.dataCbs.push(cb) }
  stderr = { on: (_ev: 'data', cb: (c: Buffer | string) => void) => this.errDataCbs.push(cb) }
  on(ev: 'error' | 'close', cb: any) {
    if (ev === 'error') this.errCbs.push(cb)
    else this.closeCbs.push(cb)
  }
  kill(signal?: string) {
    if (this.killError) throw this.killError
    this.killed = signal ?? 'SIGTERM'
    return this.killResult
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
const input = (runId: string) => ({ prompt: 'a', projectId: 'p', hasSelection: false, runId })

test('a run streams started, then parsed events, then done', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const done = runner.run(
    'chat',
    { runId: 'run-a', prompt: 'dedupe', projectId: 'p', hasSelection: false },
    (e) => events.push(e),
  )

  expect(runner.isRunning('chat')).toBe(true)
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
  expect(runner.isRunning('chat')).toBe(false)
})

test('a second run under the SAME key while one is active is refused', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const first = runner.run('chat', input('run-a'), () => {})

  const second: AgentEvent[] = []
  await runner.run('chat', input('run-b'), (e) => second.push(e))
  expect(second).toEqual([{ type: 'error', message: expect.stringContaining('already running') }])

  child.emitClose(0)
  await first
})

test('different keys run concurrently — a review run does not refuse a chat run, or vice versa', async () => {
  const chatChild = new FakeChild()
  const reviewChild = new FakeChild()
  const children = [chatChild, reviewChild]
  const runner = createAgentRunner(deps(() => children.shift()!))

  const chatEvents: AgentEvent[] = []
  const reviewEvents: AgentEvent[] = []
  const chatDone = runner.run('chat', input('chat-run'), (e) => chatEvents.push(e))
  const reviewDone = runner.run('review:rev-1', input('review-run'), (e) =>
    reviewEvents.push(e),
  )

  expect(runner.isRunning('chat')).toBe(true)
  expect(runner.isRunning('review:rev-1')).toBe(true)
  // Neither run refused the other — both got a 'started', not an "already running" error.
  expect(chatEvents).toEqual([{ type: 'started' }])
  expect(reviewEvents).toEqual([{ type: 'started' }])

  chatChild.emitClose(0)
  await chatDone
  expect(runner.isRunning('chat')).toBe(false)
  expect(runner.isRunning('review:rev-1')).toBe(true) // the other key is unaffected

  reviewChild.emitClose(0)
  await reviewDone
  expect(runner.isRunning('review:rev-1')).toBe(false)
})

test('run activity is matched by run id and attributed to its project', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const run = runner.run('chat', input('run-a'), () => {})

  expect(runner.isRunning('chat', 'run-a')).toBe(true)
  expect(runner.isRunning('chat', 'run-b')).toBe(false)
  expect(runner.isProjectRunning('p')).toBe(true)
  expect(runner.isProjectRunning('other')).toBe(false)

  child.emitClose(0)
  await run
  expect(runner.isRunning('chat', 'run-a')).toBe(false)
  expect(runner.isProjectRunning('p')).toBe(false)
})

test('a project transition excludes new runs and cannot begin while a run is active', async () => {
  const children = [new FakeChild(), new FakeChild()]
  let spawned = 0
  const runner = createAgentRunner(deps(() => children[spawned++]))
  const first = runner.run('chat', input('run-a'), () => {})

  expect(runner.tryLockProject('p')).toBeNull()
  children[0].emitClose(0)
  await first

  const unlock = runner.tryLockProject('p')
  expect(unlock).toEqual(expect.any(Function))
  const blocked: AgentEvent[] = []
  await runner.run('review:rev-1', input('run-b'), (event) => blocked.push(event))
  expect(blocked).toEqual([{ type: 'error', message: expect.stringContaining('project is changing') }])
  expect(spawned).toBe(1)

  unlock!()
  const second = runner.run('review:rev-1', input('run-b'), () => {})
  expect(spawned).toBe(2)
  children[1].emitClose(0)
  await second
})

test('an abandoned unknown run id tombstones late admission', async () => {
  let spawned = 0
  const runner = createAgentRunner(deps(() => {
    spawned += 1
    return new FakeChild()
  }))

  expect(runner.abandon('chat', 'run-late')).toEqual({ status: 'prevented' })
  const events: AgentEvent[] = []
  await runner.run('chat', input('run-late'), (event) => events.push(event))

  expect(spawned).toBe(0)
  expect(runner.isRunning('chat', 'run-late')).toBe(false)
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('abandoned') }])
})

test('abandon atomically cancels a run that won admission first', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const run = runner.run('chat', input('run-a'), () => {})

  expect(runner.abandon('chat', 'run-a')).toEqual({ status: 'accepted' })
  expect(child.killed).toBe('SIGTERM')
  expect(runner.isRunning('chat', 'run-a')).toBe(true)

  child.emitClose(null)
  await run
  expect(runner.isRunning('chat', 'run-a')).toBe(false)
})

test('a project run reservation excludes rename through child-close bookkeeping', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const reservation = runner.reserveProjectRun('p')
  expect(reservation).not.toBeNull()
  expect(runner.tryLockProject('p')).toBeNull()

  const run = runner.runReserved(reservation!, 'review:rev-1', input('attempt-a'), () => {})
  expect(runner.isRunning('review:rev-1', 'attempt-a')).toBe(true)
  child.emitClose(1)
  await run

  expect(runner.isRunning('review:rev-1', 'attempt-a')).toBe(false)
  expect(runner.tryLockProject('p')).toBeNull()
  runner.releaseProjectRun(reservation!)
  expect(runner.tryLockProject('p')).toEqual(expect.any(Function))
})

test('an active child still excludes rename if its caller releases the reservation early', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const reservation = runner.reserveProjectRun('p')!
  const run = runner.runReserved(reservation, 'review:rev-1', input('attempt-a'), () => {})

  runner.releaseProjectRun(reservation)

  expect(runner.tryLockProject('p')).toBeNull()
  child.emitClose(0)
  await run
  expect(runner.tryLockProject('p')).toEqual(expect.any(Function))
})

test('cancelAndWait does not settle until the child closes', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const run = runner.run('review:rev-1', input('attempt-a'), () => {})
  let settled = false

  const cancellation = runner.cancelAndWait('review:rev-1', 'attempt-a')
  void cancellation.then(() => { settled = true })
  await Promise.resolve()

  expect(child.killed).toBe('SIGTERM')
  expect(settled).toBe(false)
  expect(runner.isRunning('review:rev-1', 'attempt-a')).toBe(true)

  child.emitClose(null)
  await expect(cancellation).resolves.toEqual({ status: 'accepted' })
  await run
  expect(settled).toBe(true)
})

test('cancelAndWait escalates an ignored SIGTERM to SIGKILL', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner({ ...deps(() => child), cancelGraceMs: 1 })
  const run = runner.run('review:rev-1', input('attempt-a'), () => {})
  const cancellation = runner.cancelAndWait('review:rev-1', 'attempt-a')

  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(child.killed).toBe('SIGKILL')

  child.emitClose(null)
  await cancellation
  await run
})

test('cancelAndWait tombstones a not-yet-active run before reporting not-running', async () => {
  let spawned = 0
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => {
    spawned += 1
    return child
  }))
  const reservation = runner.reserveProjectRun('p', 'review:rev-1', 'attempt-a')!

  await expect(runner.cancelAndWait('review:rev-1', 'attempt-a')).resolves.toEqual({ status: 'not-running' })
  const lateRun = runner.runReserved(reservation, 'review:rev-1', input('attempt-a'), () => {})
  await Promise.resolve()

  expect(spawned).toBe(0)
  if (spawned) child.emitClose(0)
  await lateRun
})

test('project reservations uniquely admit one key and run id', () => {
  const runner = createAgentRunner(deps(() => new FakeChild()))
  const reservation = runner.reserveProjectRun('p', 'review:rev-1', 'attempt-a')

  expect(reservation).not.toBeNull()
  expect(runner.isRunAdmitted('review:rev-1', 'attempt-a')).toBe(true)
  expect(runner.reserveProjectRun('p', 'review:rev-1', 'attempt-a')).toBeNull()
  expect(runner.reserveProjectRun('p', 'review:rev-1', 'attempt-b')).toBeNull()

  runner.releaseProjectRun(reservation!)
  expect(runner.isRunAdmitted('review:rev-1', 'attempt-a')).toBe(false)
  expect(runner.reserveProjectRun('p', 'review:rev-1', 'attempt-b')).not.toBeNull()
})

test('cancel(key) kills only that key\'s child', async () => {
  const chatChild = new FakeChild()
  const reviewChild = new FakeChild()
  const children = [chatChild, reviewChild]
  const runner = createAgentRunner(deps(() => children.shift()!))
  const chatRun = runner.run('chat', input('chat-run'), () => {})
  const reviewRun = runner.run('review:rev-1', input('review-run'), () => {})

  expect(runner.cancel('review:rev-1', 'review-run')).toEqual({ status: 'accepted' })
  expect(reviewChild.killed).toBe('SIGTERM')
  expect(chatChild.killed).toBeNull()
  expect(runner.isRunning('review:rev-1')).toBe(true)
  expect(runner.isRunning('chat')).toBe(true)

  reviewChild.emitClose(null)
  chatChild.emitClose(0)
  await Promise.all([chatRun, reviewRun])
})

test('cancel keeps the run lock until the child closes', async () => {
  const child = new FakeChild()
  const spawn = () => child
  const runner = createAgentRunner(deps(spawn))
  const first = runner.run('chat', input('run-a'), () => {})

  runner.cancel('chat', 'run-a')

  expect(runner.isRunning('chat')).toBe(true)
  const second: AgentEvent[] = []
  await runner.run('chat', input('run-b'), (e) => second.push(e))
  expect(second).toEqual([{ type: 'error', message: expect.stringContaining('already running') }])

  child.emitClose(null)
  await first
  expect(runner.isRunning('chat')).toBe(false)
})

test('an error before close keeps the run locked until that child closes', async () => {
  const children = [new FakeChild(), new FakeChild()]
  let spawned = 0
  const runner = createAgentRunner(deps(() => children[spawned++]))
  let firstSettled = false
  const first = runner.run('chat', input('run-a'), () => {})
  void first.then(() => { firstSettled = true })

  children[0].emitError(new Error('spawn failed after return'))
  await Promise.resolve()

  expect(firstSettled).toBe(false)
  expect(runner.isRunning('chat')).toBe(true)
  const rejected: AgentEvent[] = []
  await runner.run('chat', input('run-b'), (e) => rejected.push(e))
  expect(rejected).toEqual([{ type: 'error', message: expect.stringContaining('already running') }])
  expect(spawned).toBe(1)

  children[0].emitClose(1)
  await first
  const second = runner.run('chat', input('run-b'), () => {})
  expect(spawned).toBe(2)

  children[0].emitClose(1)
  expect(runner.isRunning('chat')).toBe(true)
  children[1].emitClose(0)
  await second
})

test('a cancelled child closing without an exit code completes as cancelled', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const run = runner.run('chat', input('run-a'), (e) => events.push(e))

  runner.cancel('chat', 'run-a')
  child.emitClose(null)
  await run

  expect(events).toEqual([
    { type: 'started' },
    { type: 'done', reply: 'Cancelled.' },
  ])
})

test('a delayed cancel for an old run cannot signal the newer active run', async () => {
  const children = [new FakeChild(), new FakeChild()]
  let spawned = 0
  const runner = createAgentRunner(deps(() => children[spawned++]))
  const first = runner.run('chat', input('run-a'), () => {})
  children[0].emitClose(0)
  await first
  const second = runner.run('chat', input('run-b'), () => {})

  expect(runner.cancel('chat', 'run-a')).toEqual({ status: 'run-mismatch' })
  expect(children[1].killed).toBeNull()
  expect(runner.isRunning('chat')).toBe(true)
  expect(runner.cancel('chat', 'run-b')).toEqual({ status: 'accepted' })
  expect(children[1].killed).toBe('SIGTERM')

  children[1].emitClose(null)
  await second
})

test.each([
  ['returns false', (child: FakeChild) => { child.killResult = false }],
  ['throws', (child: FakeChild) => { child.killError = new Error('EPERM') }],
])('cancel reports signal failure when child.kill %s', async (_label, arrange) => {
  const child = new FakeChild()
  arrange(child)
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const run = runner.run('chat', input('run-a'), (e) => events.push(e))

  expect(runner.cancel('chat', 'run-a')).toEqual({ status: 'signal-failed' })
  expect(runner.isRunning('chat')).toBe(true)
  child.emitClose(null)
  await run

  expect(events.at(-1)).toEqual({ type: 'error', message: '`claude` exited with code null.' })
})

test('a nonzero exit with no result line becomes an error from stderr', async () => {
  const child = new FakeChild()
  const runner = createAgentRunner(deps(() => child))
  const events: AgentEvent[] = []
  const done = runner.run('chat', input('run-a'), (e) => events.push(e))
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
  await runner.run('chat', input('run-a'), (e) => events.push(e))
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('not installed') }])
  expect(runner.isRunning('chat')).toBe(false)
})

test('an unsupported ELVES_CLI is rejected with a clear message', async () => {
  const runner = createAgentRunner({ mcpConfigPath: '/repo/.mcp.json', cwd: '/repo', cliName: 'codex', spawn: () => new FakeChild() })
  const events: AgentEvent[] = []
  await runner.run('chat', input('run-a'), (e) => events.push(e))
  expect(events).toEqual([{ type: 'error', message: expect.stringContaining('not supported yet') }])
})
