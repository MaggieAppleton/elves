import { expect, test } from 'vitest'
import { TransportBreaker, ollamaGenerate } from '../../server/ollamaClient'

// The breaker exists because both repair paths would otherwise pay a full
// timeout on every call on a machine that has no Ollama — six notes in a review
// pass, or every reply in a thread. Driven by an injected clock so none of this
// depends on wall time.

function fakeClock(start = 1_000_000) {
  const state = { now: start }
  return { state, read: () => state.now }
}

test('a single failure does not open the breaker', () => {
  const { read } = fakeClock()
  const breaker = new TransportBreaker(2, 60_000, read)
  expect(breaker.recordFailure()).toBe(false)
  expect(breaker.open).toBe(false)
})

test('the second consecutive failure opens it, and says so once', () => {
  const { read } = fakeClock()
  const breaker = new TransportBreaker(2, 60_000, read)
  breaker.recordFailure()
  // Returning true is what the caller logs on, so it must be the tripping
  // failure only — not every failure after it.
  expect(breaker.recordFailure()).toBe(true)
  expect(breaker.open).toBe(true)
})

test('it closes again once the cooldown has passed', () => {
  const { state, read } = fakeClock()
  const breaker = new TransportBreaker(2, 60_000, read)
  breaker.recordFailure()
  breaker.recordFailure()
  expect(breaker.open).toBe(true)

  state.now += 59_000
  expect(breaker.open).toBe(true)
  state.now += 2_000
  expect(breaker.open).toBe(false)
})

test('a success between failures resets the count', () => {
  // A host that answers is a working host, whatever the leash then decides
  // about the text it returned. Only consecutive TRANSPORT failures count.
  const { read } = fakeClock()
  const breaker = new TransportBreaker(2, 60_000, read)
  breaker.recordFailure()
  breaker.recordSuccess()
  expect(breaker.recordFailure()).toBe(false)
  expect(breaker.open).toBe(false)
})

test('ollamaGenerate returns null rather than throwing when nothing is listening', async () => {
  expect(await ollamaGenerate({
    host: 'http://127.0.0.1:1', model: 'llama3.2', prompt: 'hi', timeoutMs: 200,
  })).toBeNull()
})

test('ollamaGenerate returns null rather than hanging past its timeout', async () => {
  // Routed at a host that accepts and never answers. The caller has a defined
  // answer for null; it has none for a promise that never settles.
  expect(await ollamaGenerate({
    host: 'http://10.255.255.1', model: 'llama3.2', prompt: 'hi', timeoutMs: 250,
  })).toBeNull()
})
