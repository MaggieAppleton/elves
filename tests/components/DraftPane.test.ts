import { createElement, StrictMode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Editor } from 'tldraw'

vi.mock('tldraw', () => ({
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))

import { DraftPane } from '../../src/components/DraftPane'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const editor = {
  getCurrentPageShapes: () => [{
    id: 'shape:card-1',
    type: 'card',
    props: {
      kind: 'prose',
      text: 'A draft paragraph.',
      mergedInto: null,
      draftExcluded: false,
      comments: [],
    },
  }],
  getShapePageBounds: () => ({ x: 0, y: 0, w: 240, h: 120 }),
} as unknown as Editor

function renderDraft(): ReactTestRenderer {
  return create(createElement(DraftPane, {
    editor,
    onSelectCard: vi.fn(),
  }))
}

function copyButton(renderer: ReactTestRenderer) {
  return renderer.root.findByProps({ 'data-testid': 'draft-copy' })
}

function copyLabel(renderer: ReactTestRenderer): string {
  return copyButton(renderer).children.join('')
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('a repeated copy replaces the previous status-reset timer', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = renderDraft() })

  await act(async () => { await copyButton(renderer).props.onClick() })
  expect(copyLabel(renderer)).toBe('Copied')
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(1000) })
  await act(async () => { await copyButton(renderer).props.onClick() })
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(401) })
  expect(copyLabel(renderer)).toBe('Copied')
  await act(async () => { vi.advanceTimersByTime(999) })
  expect(copyLabel(renderer)).toBe('Copy as Markdown')

  await act(async () => { renderer.unmount() })
})

test('an older clipboard completion cannot overwrite a newer copy status', async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const writeText = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let renderer!: ReactTestRenderer
  await act(async () => { renderer = renderDraft() })

  let firstCopy!: Promise<void>
  let secondCopy!: Promise<void>
  act(() => { firstCopy = copyButton(renderer).props.onClick() })
  act(() => { secondCopy = copyButton(renderer).props.onClick() })
  await act(async () => {
    second.resolve()
    await secondCopy
  })
  expect(copyLabel(renderer)).toBe('Copied')

  await act(async () => {
    first.reject(new Error('older failure'))
    await firstCopy
  })
  expect(copyLabel(renderer)).toBe('Copied')

  await act(async () => { renderer.unmount() })
})

test('StrictMode keeps the latest rejection authoritative over an older success', async () => {
  const older = deferred<void>()
  const latest = deferred<void>()
  const writeText = vi.fn()
    .mockImplementationOnce(() => older.promise)
    .mockImplementationOnce(() => latest.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(
      StrictMode,
      null,
      createElement(DraftPane, { editor, onSelectCard: vi.fn() }),
    ))
  })

  let olderCopy!: Promise<void>
  let latestCopy!: Promise<void>
  act(() => { olderCopy = copyButton(renderer).props.onClick() })
  act(() => { latestCopy = copyButton(renderer).props.onClick() })
  await act(async () => {
    latest.reject(new Error('latest failure'))
    await latestCopy
  })

  expect(copyLabel(renderer)).toBe('Copy failed')
  expect(log).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => {
    older.resolve()
    await olderCopy
  })
  expect(copyLabel(renderer)).toBe('Copy failed')
  expect(log).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(1400) })
  expect(copyLabel(renderer)).toBe('Copy as Markdown')
  expect(vi.getTimerCount()).toBe(0)

  await act(async () => { renderer.unmount() })
})

test('unmount clears reset timers and invalidates pending clipboard completion', async () => {
  const pending = deferred<void>()
  const writeText = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => pending.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })

  let settledRenderer!: ReactTestRenderer
  await act(async () => { settledRenderer = renderDraft() })
  await act(async () => { await copyButton(settledRenderer).props.onClick() })
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => { settledRenderer.unmount() })
  expect(vi.getTimerCount()).toBe(0)

  let pendingRenderer!: ReactTestRenderer
  await act(async () => { pendingRenderer = renderDraft() })
  let copyPromise!: Promise<void>
  act(() => { copyPromise = copyButton(pendingRenderer).props.onClick() })
  await act(async () => { pendingRenderer.unmount() })
  await act(async () => {
    pending.resolve()
    await copyPromise
  })
  expect(vi.getTimerCount()).toBe(0)
})
