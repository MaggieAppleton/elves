import { afterAll, afterEach, beforeAll, expect, test } from 'vitest'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import request from 'supertest'
import { createServer } from '../../server/app'
import type { AgentRunner, AgentEvent, AgentCancelResult } from '../../server/agentRun'

// A scriptable AgentRunner: `run` replays a fixed list of events then resolves.
// `running` is toggleable so we can exercise the "already running" 409. Chat
// routes always pass key 'chat' (see server/app.ts), so `running` models
// whether that key is busy; cancellation records both the key and run id.
function fakeAgent(
  events: AgentEvent[] = [],
  running = false,
  cancelResult: AgentCancelResult = { status: 'accepted' },
): AgentRunner & {
  cancelled: { key: string; runId: string }[]
  abandoned: { key: string; runId: string }[]
} {
  const impl = {
    cancelled: [] as { key: string; runId: string }[],
    abandoned: [] as { key: string; runId: string }[],
    isRunning: (_key: string, runId?: string) => running && (!runId || runId === 'run-a'),
    isProjectRunning: (projectId: string) => running && projectId === 'essay',
    reserveProjectRun: (projectId: string) => ({ projectId }),
    isRunAdmitted: () => false,
    prepare: () => running ? { status: 'conflict' as const } : { status: 'accepted' as const },
    claimPrepared: (key: string, input: any) => running ? null : ({ projectId: input.projectId, key }),
    releaseProjectRun: () => {},
    abandon(key: string, runId: string) {
      impl.abandoned.push({ key, runId })
      return { status: running ? 'accepted' as const : 'prevented' as const }
    },
    async cancelAndWait(key: string, runId: string) {
      return impl.cancel(key, runId)
    },
    async runReserved(_reservation: unknown, key: string, input: unknown, onEvent: (e: AgentEvent) => void) {
      return impl.run(key, input, onEvent)
    },
    runPrepared(key: string, input: unknown, onEvent: (e: AgentEvent) => void) {
      return running ? null : impl.run(key, input, onEvent)
    },
    tryLockProject: (_projectId: string) => running ? null : () => {},
    cancel(key: string, runId: string) {
      impl.cancelled.push({ key, runId })
      return cancelResult
    },
    async run(_key: string, _input: unknown, onEvent: (e: AgentEvent) => void) {
      for (const e of events) onEvent(e)
    },
  }
  return impl
}

let agentRoot: string
beforeAll(async () => {
  agentRoot = await mkdtemp(join(tmpdir(), 'elves-agent-routes-'))
  await request(createServer(agentRoot)).post('/projects').send({ name: 'Essay' }).expect(200)
})
afterAll(async () => {
  await rm(agentRoot, { recursive: true, force: true })
})
const app = (agent?: AgentRunner) => createServer(agentRoot, undefined, undefined, undefined, undefined, agent)

// SSE responses don't resolve cleanly under supertest/superagent, so the
// streaming case runs against a real listening server and reads the raw body.
const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))))
  servers.length = 0
})

function listen(agent?: AgentRunner): Promise<number> {
  const server = http.createServer(app(agent))
  servers.push(server)
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    }),
  )
}

function postForStream(port: number, body: unknown): Promise<{ status: number; contentType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port, path: '/agent/run', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

test('POST /agent/run streams SSE events then an end marker', async () => {
  const port = await listen(
    fakeAgent([
      { type: 'started' },
      { type: 'tool', name: 'read_selection', summary: '2 cards' },
      { type: 'done', reply: 'Critiqued.' },
    ]),
  )
  const res = await postForStream(port, {
    prompt: 'critique this card', projectId: 'essay', hasSelection: true, runId: 'run-a',
  })

  expect(res.status).toBe(200)
  expect(res.contentType).toContain('text/event-stream')
  expect(res.text).toContain('data: {"type":"started"}')
  expect(res.text).toContain('data: {"type":"tool","name":"read_selection","summary":"2 cards"}')
  expect(res.text).toContain('data: {"type":"done","reply":"Critiqued."}')
  expect(res.text).toContain('event: end')
})

test('POST /agent/prepare acknowledges a bounded run admission', async () => {
  const res = await request(app(fakeAgent())).post('/agent/prepare').send({
    projectId: 'essay', runId: 'run-a',
  })

  expect(res.status).toBe(200)
  expect(res.body).toEqual({ ok: true, status: 'accepted' })
})

test('POST /agent/run refuses an absent or expired preparation before streaming', async () => {
  const agent = fakeAgent()
  agent.claimPrepared = () => null
  const res = await request(app(agent)).post('/agent/run').send({
    prompt: 'hi', projectId: 'essay', runId: 'run-a',
  })

  expect(res.status).toBe(409)
  expect(res.headers['content-type']).toContain('application/json')
})

test('POST /agent/run validates the project after claiming its preparation', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({
    prompt: 'hi', projectId: 'definitely-missing-project', runId: 'run-a',
  })

  expect(res.status).toBe(404)
})

test('POST /agent/run rejects a missing prompt', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({ projectId: 'essay', runId: 'run-a' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/prompt/)
})

test('POST /agent/run rejects a missing projectId', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({ prompt: 'hi', runId: 'run-a' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/projectId/)
})

test('POST /agent/run rejects a missing runId', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({ prompt: 'hi', projectId: 'essay' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/runId/)
})

test('POST /agent/run returns 409 when an agent is already running', async () => {
  const res = await request(app(fakeAgent([], /* running */ true)))
    .post('/agent/run')
    .send({ prompt: 'hi', projectId: 'essay', runId: 'run-a' })
  expect(res.status).toBe(409)
})

test('POST /agent/run returns 501 when no runner is configured', async () => {
  const res = await request(app(undefined)).post('/agent/run').send({ prompt: 'hi', projectId: 'essay', runId: 'run-a' })
  expect(res.status).toBe(501)
})

test('GET /agent/runs/:runId reports authoritative matching-run activity', async () => {
  const active = await request(app(fakeAgent([], true))).get('/agent/runs/run-a')
  expect(active.body).toEqual({ active: true })
  expect(active.headers['cache-control']).toBe('no-store')
  expect((await request(app(fakeAgent([], true))).get('/agent/runs/run-b')).body).toEqual({ active: false })
})

test('POST /agent/abandon atomically acknowledges the ambiguous run id', async () => {
  const agent = fakeAgent()
  const response = await request(app(agent)).post('/agent/abandon').send({ runId: 'run-late' })

  expect(response.status).toBe(200)
  expect(response.body).toEqual({ ok: true, status: 'prevented' })
  expect(agent.abandoned).toEqual([{ key: 'chat', runId: 'run-late' }])
})

test('PATCH /projects/:id refuses rename while that project has an active agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'elves-agent-rename-'))
  try {
    const server = createServer(root, undefined, undefined, undefined, undefined, fakeAgent([], true))
    await request(server).post('/projects').send({ name: 'Essay' }).expect(200)

    const res = await request(server).patch('/projects/essay').send({ name: 'Renamed' })

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'project-agent-active' })
    expect((await request(server).get('/projects')).body).toEqual([
      expect.objectContaining({ id: 'essay', name: 'Essay' }),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('POST /agent/cancel cancels only the requested run', async () => {
  const agent = fakeAgent()
  const res = await request(app(agent)).post('/agent/cancel').send({ runId: 'run-a' })
  expect(res.status).toBe(200)
  expect(agent.cancelled).toEqual([{ key: 'chat', runId: 'run-a' }])
})

// A review run is keyed 'review:<id>', never 'chat' — so it must not trip the
// chat route's single-flight check, which only asks isRunning('chat').
test('a review run in progress does not 409 a chat run', async () => {
  const agent: AgentRunner = {
    isRunning: (key) => key === 'review:rev-1',
    isProjectRunning: () => false,
    reserveProjectRun: (projectId) => ({ projectId }),
    isRunAdmitted: () => false,
    prepare: () => ({ status: 'accepted' }),
    claimPrepared: (_key, input) => ({ projectId: input.projectId }),
    releaseProjectRun: () => {},
    abandon: () => ({ status: 'prevented' }),
    cancelAndWait: async () => ({ status: 'not-running' }),
    runReserved: async (_reservation, key, input, onEvent) => {
      await agent.run(key, input, onEvent)
    },
    runPrepared: (_key, input, onEvent) => agent.run('chat', input, onEvent),
    tryLockProject: () => () => {},
    cancel: () => ({ status: 'not-running' }),
    async run(_key, _input, onEvent) {
      onEvent({ type: 'started' })
      onEvent({ type: 'done', reply: 'ok' })
    },
  }
  const res = await request(app(agent)).post('/agent/run').send({
    prompt: 'hi', projectId: 'essay', runId: 'run-a',
  })
  expect(res.status).toBe(200)
})

test.each([
  ['not-running', 409],
  ['run-mismatch', 409],
  ['signal-failed', 503],
] as const)('POST /agent/cancel maps %s truthfully', async (status, httpStatus) => {
  const res = await request(app(fakeAgent([], false, { status })))
    .post('/agent/cancel')
    .send({ runId: 'run-a' })
  expect(res.status).toBe(httpStatus)
  expect(res.body).toMatchObject({ code: status, error: expect.any(String) })
})

test('POST /agent/cancel rejects a missing runId', async () => {
  const res = await request(app(fakeAgent())).post('/agent/cancel').send({})
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/runId/)
})
