import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { atom, type Editor } from 'tldraw'
import { trackSelection } from '../../src/client/selection'

// A minimal reactive stand-in for the editor: getSelectedShapeIds reads an atom,
// so trackSelection's reactor re-runs when we set it — no real canvas needed.
function fakeEditor() {
  const sel = atom<string[]>('selection', [])
  const editor = { getSelectedShapeIds: () => sel.get() } as unknown as Editor
  return { editor, select: (ids: string[]) => sel.set(ids) }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('reports the selection to the server after the debounce window', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => 'garden', post, debounceMs: 200 })

  select(['shape:a', 'shape:b'])
  expect(post).not.toHaveBeenCalled() // still within the debounce
  vi.advanceTimersByTime(200)
  expect(post).toHaveBeenCalledWith('garden', ['shape:a', 'shape:b'])
  stop()
})

test('coalesces a burst of changes into a single report (last one wins)', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => 'garden', post, debounceMs: 200 })

  select(['shape:a'])
  vi.advanceTimersByTime(50)
  select(['shape:a', 'shape:b'])
  vi.advanceTimersByTime(50)
  select(['shape:c'])
  vi.advanceTimersByTime(200)

  expect(post).toHaveBeenCalledTimes(1)
  expect(post).toHaveBeenCalledWith('garden', ['shape:c'])
  stop()
})

test('reports a deselection (empty selection is a real state, not a no-op)', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => 'garden', post, debounceMs: 0 })

  select(['shape:a'])
  vi.advanceTimersByTime(0)
  select([])
  vi.advanceTimersByTime(0)

  expect(post).toHaveBeenLastCalledWith('garden', [])
  stop()
})

test('does not re-report an unchanged selection', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => 'garden', post, debounceMs: 0 })

  select(['shape:a'])
  vi.advanceTimersByTime(0)
  select(['shape:a']) // same set again
  vi.advanceTimersByTime(0)

  expect(post).toHaveBeenCalledTimes(1)
  stop()
})

test('skips reporting while no project is open', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => null, post, debounceMs: 0 })

  select(['shape:a'])
  vi.advanceTimersByTime(0)
  expect(post).not.toHaveBeenCalled()
  stop()
})

test('the disposer cancels a pending report', () => {
  const { editor, select } = fakeEditor()
  const post = vi.fn()
  const stop = trackSelection(editor, { getProjectId: () => 'garden', post, debounceMs: 200 })

  select(['shape:a'])
  stop() // before the debounce fires
  vi.advanceTimersByTime(200)
  expect(post).not.toHaveBeenCalled()
})
