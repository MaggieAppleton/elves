import { describe, expect, test } from 'vitest'
import {
  withProjectLock,
  withProjectLocks,
  withProjectNamespaceLock,
} from '../../server/projectLock'

describe('project mutation locks', () => {
  test('same-project callbacks run in enqueue order', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withProjectLock('/data', 'essay', async () => {
      events.push('first:start')
      await gate
      events.push('first:end')
    })
    const second = withProjectLock('/data', 'essay', async () => {
      events.push('second')
    })
    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  test('different projects do not block one another', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withProjectLock('/data', 'one', () => gate)
    let secondRan = false
    await withProjectLock('/data', 'two', async () => { secondRan = true })
    expect(secondRan).toBe(true)
    release()
    await first
  })

  test('a rejected callback releases the project lock', async () => {
    await expect(withProjectLock('/data', 'essay', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(withProjectLock('/data', 'essay', async () => 'next')).resolves.toBe('next')
  })

  test('a rejected callback releases the namespace lock', async () => {
    await expect(withProjectNamespaceLock('/namespace-failure', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(
      withProjectNamespaceLock('/namespace-failure', async () => 'next'),
    ).resolves.toBe('next')
  })

  test('multi-lock acquisition deduplicates ids', async () => {
    let calls = 0
    await withProjectLocks('/data', ['b', 'a', 'a'], async () => { calls++ })
    expect(calls).toBe(1)
  })

  test('opposite project-id orders cannot deadlock', async () => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    // Both calls must enqueue synchronously. Without canonical sorting the
    // first owns b while waiting for a and the second owns a while waiting for
    // b, so neither callback can enter and this test times out.
    const first = withProjectLocks('/opposite-order', ['b', 'a'], async () => {
      entered()
      await gate
    })
    let secondRan = false
    const second = withProjectLocks('/opposite-order', ['a', 'b'], async () => {
      secondRan = true
    })
    await started
    release()
    await Promise.all([first, second])
    expect(secondRan).toBe(true)
  })

  test('a rejected multi-project callback releases every acquired lock', async () => {
    await expect(withProjectLocks('/multi-failure', ['b', 'a'], async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(Promise.all([
      withProjectLock('/multi-failure', 'a', async () => 'a'),
      withProjectLock('/multi-failure', 'b', async () => 'b'),
    ])).resolves.toEqual(['a', 'b'])
  })

  test('namespace callbacks serialize', async () => {
    const events: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withProjectNamespaceLock('/data', async () => {
      events.push('first')
      await gate
    })
    const second = withProjectNamespaceLock('/data', async () => { events.push('second') })
    await Promise.resolve()
    expect(events).toEqual(['first'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first', 'second'])
  })
})
