import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import type { AgentRunner, AgentEvent } from '../../server/agentRun'

// A scriptable AgentRunner: `run` replays a fixed list of events then resolves.
// `running` is toggleable so we can exercise the "already running" 409.
function fakeAgent(events: AgentEvent[] = [], running = false): AgentRunner & { cancelled: boolean } {
  const impl = {
    cancelled: false,
    isRunning: () => running,
    cancel() {
      impl.cancelled = true
    },
    async run(_input: unknown, onEvent: (e: AgentEvent) => void) {
      for (const e of events) onEvent(e)
    },
  }
  return impl
}

// The agent routes never touch disk (no requireProject), so a bogus data root is fine.
const app = (agent?: AgentRunner) => createServer(tmpdir(), undefined, undefined, undefined, undefined, agent)

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
  const res = await postForStream(port, { prompt: 'critique this card', projectId: 'essay', hasSelection: true })

  expect(res.status).toBe(200)
  expect(res.contentType).toContain('text/event-stream')
  expect(res.text).toContain('data: {"type":"started"}')
  expect(res.text).toContain('data: {"type":"tool","name":"read_selection","summary":"2 cards"}')
  expect(res.text).toContain('data: {"type":"done","reply":"Critiqued."}')
  expect(res.text).toContain('event: end')
})

test('POST /agent/run rejects a missing prompt', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({ projectId: 'essay' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/prompt/)
})

test('POST /agent/run rejects a missing projectId', async () => {
  const res = await request(app(fakeAgent())).post('/agent/run').send({ prompt: 'hi' })
  expect(res.status).toBe(400)
  expect(res.body.error).toMatch(/projectId/)
})

test('POST /agent/run returns 409 when an agent is already running', async () => {
  const res = await request(app(fakeAgent([], /* running */ true)))
    .post('/agent/run')
    .send({ prompt: 'hi', projectId: 'essay' })
  expect(res.status).toBe(409)
})

test('POST /agent/run returns 501 when no runner is configured', async () => {
  const res = await request(app(undefined)).post('/agent/run').send({ prompt: 'hi', projectId: 'essay' })
  expect(res.status).toBe(501)
})

test('POST /agent/cancel cancels the run', async () => {
  const agent = fakeAgent()
  const res = await request(app(agent)).post('/agent/cancel').send({})
  expect(res.status).toBe(200)
  expect(agent.cancelled).toBe(true)
})
