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
    const first = withProjectLocks('/data', ['b', 'a'], async () => {
      entered()
      await gate
    })
    await started
    let secondRan = false
    const second = withProjectLocks('/data', ['a', 'b'], async () => { secondRan = true })
    release()
    await Promise.all([first, second])
    expect(secondRan).toBe(true)
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
