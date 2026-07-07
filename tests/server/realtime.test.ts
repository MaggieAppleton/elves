import { afterEach, expect, test } from 'vitest'
import http from 'node:http'
import { WebSocket } from 'ws'
import { attachRealtime } from '../../server/realtime'

let servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
  servers = []
})

function startServer(): Promise<{ port: number }> {
  const httpServer = http.createServer()
  attachRealtime(httpServer)
  servers.push(httpServer)
  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const address = httpServer.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port })
    })
  })
}

test('a WebSocket connection with a disallowed Origin is rejected', async () => {
  const { port } = await startServer()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://evil.example' } })
  const outcome = await new Promise<'open' | 'error-or-close'>((resolve) => {
    ws.on('open', () => resolve('open'))
    ws.on('error', () => resolve('error-or-close'))
    ws.on('unexpected-response', () => resolve('error-or-close'))
  })
  expect(outcome).toBe('error-or-close')
  ws.terminate()
})

test('a WebSocket connection with an allowed Origin is accepted', async () => {
  const { port } = await startServer()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://localhost:5173' } })
  const outcome = await new Promise<'open' | 'error-or-close'>((resolve) => {
    ws.on('open', () => resolve('open'))
    ws.on('error', () => resolve('error-or-close'))
    ws.on('unexpected-response', () => resolve('error-or-close'))
  })
  expect(outcome).toBe('open')
  ws.terminate()
})

test('a WebSocket connection with no Origin header is accepted (non-browser clients)', async () => {
  const { port } = await startServer()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const outcome = await new Promise<'open' | 'error-or-close'>((resolve) => {
    ws.on('open', () => resolve('open'))
    ws.on('error', () => resolve('error-or-close'))
    ws.on('unexpected-response', () => resolve('error-or-close'))
  })
  expect(outcome).toBe('open')
  ws.terminate()
})
