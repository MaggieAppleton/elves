import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('tldraw', () => ({
  Tldraw: () => null,
  createShapeId: () => 'shape:new',
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))
vi.mock('../../src/shapes/CardShapeUtil', () => ({ CardShapeUtil: {} }))
vi.mock('../../src/shapes/CardSelectionForeground', () => ({ CardSelectionForeground: {} }))
vi.mock('../../src/shapes/SnapHighlight', () => ({ SnapHighlight: {} }))
vi.mock('../../src/shapes/SectionShapeUtil', () => ({ SectionShapeUtil: {} }))
vi.mock('../../src/shapes/QuestionShapeUtil', () => ({ QuestionShapeUtil: {} }))
vi.mock('../../src/shapes/FeedbackShapeUtil', () => ({ FeedbackShapeUtil: {} }))
vi.mock('../../src/shapes/mergeView', () => ({ cardIsHidden: () => false, collapseAll: vi.fn() }))
vi.mock('../../src/client/persistence', () => ({
  listProjects: vi.fn().mockResolvedValue([{ id: 'essay', name: 'Essay' }]),
  loadCanvasVersioned: vi.fn(), saveCanvasVersioned: vi.fn(), createProject: vi.fn(), renameProject: vi.fn(),
}))
vi.mock('../../src/client/assets', () => ({ uploadAsset: vi.fn(), useAssetProject: vi.fn() }))
vi.mock('../../src/client/realtime', () => ({ connectRealtime: vi.fn(() => () => {}) }))
vi.mock('../../src/client/selection', () => ({ trackSelection: vi.fn() }))
vi.mock('../../src/client/presence', () => ({ markDoing: vi.fn(), markLooking: vi.fn(), clearPresence: vi.fn() }))
vi.mock('../../src/client/reviews', () => ({
  fetchReviews: vi.fn().mockResolvedValue([]), summonReview: vi.fn(), dismissReview: vi.fn(), retryReview: vi.fn(),
}))

import App, { retryAnnotationCanRun } from '../../src/App'
import { DraftPane } from '../../src/components/DraftPane'
import { clearAnnotationPresentations, requestAnnotationOpen } from '../../src/client/annotationSelection'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  clearAnnotationPresentations()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), prompt: vi.fn(),
  })
})

afterEach(() => {
  clearAnnotationPresentations()
  vi.unstubAllGlobals()
})

test('opening an annotation pin leaves the canvas-only view and draft divider unchanged', async () => {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  const stage = () => tree.root.findByProps({ className: 'elves-stage' })
  expect(stage().props['data-view']).toBe('canvas')
  expect(tree.root.findAllByProps({ 'data-testid': 'draft-divider' })).toHaveLength(0)

  act(() => { requestAnnotationOpen({ kind: 'card', cardId: 'shape:card', commentId: 'comment:one' }) })

  expect(stage().props['data-view']).toBe('canvas')
  expect(tree.root.findAllByProps({ 'data-testid': 'draft-divider' })).toHaveLength(0)
  await act(async () => { tree.unmount() })
})

test('mounts the draft pane only after leaving canvas view', async () => {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findAllByType(DraftPane)).toHaveLength(0)

  await act(async () => {
    tree.root.findByProps({ 'data-testid': 'draft-open' }).props.onClick()
  })

  expect(tree.root.findAllByType(DraftPane)).toHaveLength(1)
  await act(async () => { tree.unmount() })
})

test('canvas mutation locks and active runs reject annotation retries before dispatch', () => {
  expect(retryAnnotationCanRun('essay', 'message-1', true, false)).toBe(false)
  expect(retryAnnotationCanRun('essay', 'message-1', false, true)).toBe(false)
  expect(retryAnnotationCanRun('essay', 'message-1', false, false)).toBe(true)
})
