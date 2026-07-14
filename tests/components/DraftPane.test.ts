// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
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

type Harness = { container: HTMLDivElement; root: Root }
const mounted = new Set<Harness>()
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

function render(node: ReactNode): Harness {
  const container = document.createElement('div')
  document.body.append(container)
  const harness = { container, root: createRoot(container) }
  mounted.add(harness)
  act(() => { harness.root.render(node) })
  return harness
}

function renderDraft(): Harness {
  return render(createElement(DraftPane, {
    editor,
    onSelectCard: vi.fn(),
  }))
}

function unmount(harness: Harness) {
  act(() => { harness.root.unmount() })
  harness.container.remove()
  mounted.delete(harness)
}

function copyButton(harness: Harness): HTMLButtonElement {
  const button = harness.container.querySelector<HTMLButtonElement>('[data-testid="draft-copy"]')
  if (!button) throw new Error('copy button not rendered')
  return button
}

function copyLabel(harness: Harness): string {
  return copyButton(harness).textContent ?? ''
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
})

afterEach(() => {
  for (const harness of mounted) unmount(harness)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

test('a repeated copy replaces the previous status-reset timer', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const renderer = renderDraft()

  await act(async () => { copyButton(renderer).click() })
  expect(copyLabel(renderer)).toBe('Copied')
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(1000) })
  await act(async () => { copyButton(renderer).click() })
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(401) })
  expect(copyLabel(renderer)).toBe('Copied')
  await act(async () => { vi.advanceTimersByTime(999) })
  expect(copyLabel(renderer)).toBe('Copy as Markdown')

  unmount(renderer)
})

test('an older clipboard completion cannot overwrite a newer copy status', async () => {
  const first = deferred<void>()
  const second = deferred<void>()
  const writeText = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const renderer = renderDraft()

  act(() => { copyButton(renderer).click() })
  act(() => { copyButton(renderer).click() })
  await act(async () => {
    second.resolve()
    await second.promise
  })
  expect(copyLabel(renderer)).toBe('Copied')

  await act(async () => {
    first.reject(new Error('older failure'))
    await first.promise.catch(() => {})
  })
  expect(copyLabel(renderer)).toBe('Copied')

  unmount(renderer)
})

test('StrictMode keeps the latest rejection authoritative over an older success', async () => {
  const lifecycle = { setups: 0, cleanups: 0 }
  function LifecycleProbe() {
    useEffect(() => {
      lifecycle.setups += 1
      return () => { lifecycle.cleanups += 1 }
    }, [])
    return null
  }
  const older = deferred<void>()
  const latest = deferred<void>()
  const writeText = vi.fn()
    .mockImplementationOnce(() => older.promise)
    .mockImplementationOnce(() => latest.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const renderer = render(createElement(
    StrictMode,
    null,
    createElement(LifecycleProbe),
    createElement(DraftPane, { editor, onSelectCard: vi.fn() }),
  ))
  expect(lifecycle).toEqual({ setups: 2, cleanups: 1 })

  act(() => { copyButton(renderer).click() })
  act(() => { copyButton(renderer).click() })
  await act(async () => {
    latest.reject(new Error('latest failure'))
    await latest.promise.catch(() => {})
  })

  expect(copyLabel(renderer)).toBe('Copy failed')
  expect(log).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => {
    older.resolve()
    await older.promise
  })
  expect(copyLabel(renderer)).toBe('Copy failed')
  expect(log).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(1)

  await act(async () => { vi.advanceTimersByTime(1400) })
  expect(copyLabel(renderer)).toBe('Copy as Markdown')
  expect(vi.getTimerCount()).toBe(0)

  unmount(renderer)
})

test('unmount clears reset timers and invalidates pending clipboard completion', async () => {
  const pending = deferred<void>()
  const writeText = vi.fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => pending.promise)
  vi.stubGlobal('navigator', { clipboard: { writeText } })

  const settledRenderer = renderDraft()
  await act(async () => { copyButton(settledRenderer).click() })
  expect(vi.getTimerCount()).toBe(1)
  unmount(settledRenderer)
  expect(vi.getTimerCount()).toBe(0)

  const pendingRenderer = renderDraft()
  act(() => { copyButton(pendingRenderer).click() })
  unmount(pendingRenderer)
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(vi.getTimerCount()).toBe(0)
})
