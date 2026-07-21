// @vitest-environment jsdom

import { act, createElement, StrictMode, useEffect, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { Editor } from 'tldraw'

vi.mock('tldraw', () => ({
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))

vi.mock('../../src/client/assets', () => ({
  assetUrl: (assetId: string) => `/assets/${assetId}`,
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

const visualEditor = {
  getCurrentPageShapes: () => [
    {
      id: 'shape:prose-before',
      type: 'card',
      props: {
        kind: 'prose',
        noteKind: null,
        text: 'Before the visual.',
        mergedInto: null,
        draftExcluded: false,
        comments: [],
      },
    },
    {
      id: 'shape:figure',
      type: 'card',
      props: {
        kind: 'figure',
        noteKind: null,
        text: 'Show the loop.',
        figureTitle: 'Loop diagram',
        figureStatus: 'sketched',
        mergedInto: null,
        draftExcluded: false,
        comments: [],
      },
    },
    {
      id: 'shape:image',
      type: 'card',
      props: {
        kind: 'note',
        noteKind: 'image',
        text: '',
        assetId: 'loop.png',
        mergedInto: null,
        draftExcluded: false,
        comments: [],
      },
    },
    {
      id: 'shape:prose-after',
      type: 'card',
      props: {
        kind: 'prose',
        noteKind: null,
        text: 'After the visual.',
        mergedInto: null,
        draftExcluded: false,
        comments: [],
      },
    },
  ],
  getShapePageBounds: (id: string) => {
    const y: Record<string, number> = {
      'shape:prose-before': 0,
      'shape:figure': 100,
      'shape:image': 200,
      'shape:prose-after': 300,
    }
    return { x: 0, y: y[id] ?? 0, w: 240, h: 120 }
  },
} as unknown as Editor

const markdownSource =
  'Read [Maggie](https://maggieappleton.com) and [unsafe](javascript:alert(1)).'

const markdownEditor = {
  getCurrentPageShapes: () => [{
    id: 'shape:linked-prose',
    type: 'card',
    props: {
      kind: 'prose',
      text: markdownSource,
      mergedInto: null,
      draftExcluded: false,
      comments: [],
      attribution: [],
    },
  }],
  getShapePageBounds: () => ({ x: 0, y: 0, w: 240, h: 120 }),
  getShape: vi.fn(() => ({ props: { text: markdownSource, attribution: [] } })),
  updateShape: vi.fn(),
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

test('renders figures and images between prose in draft order', () => {
  const renderer = render(createElement(DraftPane, {
    editor: visualEditor,
    onSelectCard: vi.fn(),
  }))

  const bodyText = renderer.container.querySelector('.elves-draft__body')?.textContent ?? ''
  expect(bodyText).toContain('Before the visual.')
  expect(bodyText.indexOf('Before the visual.')).toBeLessThan(bodyText.indexOf('Loop diagram'))
  expect(bodyText.indexOf('Loop diagram')).toBeLessThan(bodyText.indexOf('sketched'))
  expect(bodyText.indexOf('sketched')).toBeLessThan(bodyText.indexOf('Show the loop.'))
  expect(bodyText.indexOf('Show the loop.')).toBeLessThan(bodyText.indexOf('After the visual.'))

  const image = renderer.container.querySelector<HTMLImageElement>('[data-testid="draft-image"]')
  expect(image?.src).toContain('/assets/loop.png')

  unmount(renderer)
})

test('copy-as-Markdown includes figures and images in draft order', async () => {
  const writeText = vi.fn(async () => {})
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const renderer = render(createElement(DraftPane, {
    editor: visualEditor,
    onSelectCard: vi.fn(),
  }))

  await act(async () => { copyButton(renderer).click() })

  expect(writeText).toHaveBeenCalledWith(
    'Before the visual.\n\n' +
    '[Figure: Loop diagram]\n\nStatus: sketched\n\nShow the loop.\n\n' +
    '![Image](loop.png)\n\nAfter the visual.',
  )

  unmount(renderer)
})

test('renders safe Markdown links beside a separate prose edit control', () => {
  const onSelectCard = vi.fn()
  const renderer = render(createElement(DraftPane, {
    editor: markdownEditor,
    onSelectCard,
  }))

  const row = renderer.container.querySelector<HTMLElement>('[data-testid="draft-para"]')
  const link = row?.querySelector<HTMLAnchorElement>('a')
  const edit = row?.querySelector<HTMLButtonElement>('button[aria-label="Edit paragraph"]')
  expect(link?.textContent).toBe('Maggie')
  expect(link?.href).toBe('https://maggieappleton.com/')
  expect(link?.target).toBe('_blank')
  expect(link?.rel).toBe('noreferrer')
  expect(row?.textContent).toContain('[unsafe](javascript:alert(1)).')
  expect(link?.closest('button, [role="button"]')).toBeNull()
  expect(edit).not.toBeNull()

  link?.addEventListener('click', (event) => event.preventDefault(), { once: true })
  act(() => { link?.click() })
  expect(onSelectCard).not.toHaveBeenCalled()

  act(() => { edit?.click() })
  const textarea = renderer.container.querySelector<HTMLTextAreaElement>('[data-testid="draft-editor"]')
  expect(textarea?.value).toBe(markdownSource)
  expect(onSelectCard).toHaveBeenCalledWith('shape:linked-prose')

  unmount(renderer)
})
