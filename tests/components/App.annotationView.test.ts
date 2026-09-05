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
import { clearAnnotationPresentations, requestAnnotationOpen } from '../../src/client/annotationSelection'
import { createProject, listProjects } from '../../src/client/persistence'

const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  clearAnnotationPresentations()
  vi.mocked(listProjects).mockReset().mockResolvedValue([{
    id: 'essay', name: 'Essay', createdAt: '2026-09-05T09:00:00.000Z',
  }])
  vi.mocked(createProject).mockReset()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  })
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), prompt: vi.fn(),
  })
  vi.stubGlobal('document', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
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

test('canvas mutation locks and active runs reject annotation retries before dispatch', () => {
  expect(retryAnnotationCanRun('essay', 'message-1', true, false)).toBe(false)
  expect(retryAnnotationCanRun('essay', 'message-1', false, true)).toBe(false)
  expect(retryAnnotationCanRun('essay', 'message-1', false, false)).toBe(true)
})

test('a failed initial project read shows recovery instead of the empty-store action', async () => {
  vi.mocked(listProjects).mockRejectedValueOnce(new Error('API unavailable'))
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findAllByProps({ 'data-testid': 'project-load-error' })).toHaveLength(1)
  expect(tree.root.findAllByProps({ 'data-testid': 'project-new' })).toHaveLength(0)
  expect(tree.root.findAll((node) => node.children.includes('No projects yet'))).toHaveLength(0)

  vi.mocked(listProjects).mockResolvedValueOnce([{
    id: 'recovered', name: 'Recovered', createdAt: '2026-09-05T09:00:00.000Z',
  }])
  const retry = tree.root.findByProps({ 'data-testid': 'project-load-retry' })
  await act(async () => {
    retry.props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findAllByProps({ 'data-testid': 'project-load-error' })).toHaveLength(0)
  expect(tree.root.findByProps({ className: 'elves-stage' })).toBeTruthy()
  await act(async () => { tree.unmount() })
})

test('a successful empty project read keeps the genuine empty-store action', async () => {
  vi.mocked(listProjects).mockResolvedValueOnce([])
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findAllByProps({ 'data-testid': 'project-load-error' })).toHaveLength(0)
  expect(tree.root.findAll((node) => node.children.includes('No projects yet'))).toHaveLength(1)
  expect(tree.root.findAllByProps({ 'data-testid': 'project-new' })).toHaveLength(1)
  await act(async () => { tree.unmount() })
})

test('a failed refresh keeps the last successful project list and exposes Retry', async () => {
  const existing = { id: 'essay', name: 'Essay', createdAt: '2026-09-05T09:00:00.000Z' }
  vi.mocked(listProjects)
    .mockResolvedValueOnce([existing])
    .mockRejectedValueOnce(new Error('refresh unavailable'))
  vi.mocked(createProject).mockResolvedValueOnce({
    id: 'new-project', name: 'New project', createdAt: '2026-09-05T09:05:00.000Z',
  })
  vi.mocked(window.prompt).mockReturnValueOnce('New project')
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  act(() => { tree.root.findByProps({ 'data-testid': 'project-switcher' }).props.onClick() })
  await act(async () => {
    tree.root.findByProps({ 'data-testid': 'project-new' }).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findByProps({ 'data-testid': 'project-switcher' }).children).toBeTruthy()
  expect(tree.root.findAllByProps({ 'data-testid': 'project-list-error' })).toHaveLength(1)
  expect(tree.root.findAllByProps({ 'data-testid': 'project-load-retry' })).toHaveLength(1)
  expect(tree.root.findAll((node) => node.children.includes('No projects yet'))).toHaveLength(0)
  await act(async () => { tree.unmount() })
})

test.each([
  ['a different server project', [{
    id: 'replacement', name: 'Replacement', createdAt: '2026-09-05T09:10:00.000Z',
  }]],
  ['an empty server list', []],
])('a later successful Retry preserves the mounted canvas when it returns %s', async (_label, retryList) => {
  const existing = { id: 'essay', name: 'Essay', createdAt: '2026-09-05T09:00:00.000Z' }
  vi.mocked(listProjects)
    .mockResolvedValueOnce([existing])
    .mockRejectedValueOnce(new Error('refresh unavailable'))
    .mockResolvedValueOnce(retryList)
  vi.mocked(createProject).mockResolvedValueOnce({
    id: 'new-project', name: 'New project', createdAt: '2026-09-05T09:05:00.000Z',
  })
  vi.mocked(window.prompt).mockReturnValueOnce('New project')
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(App))
    await Promise.resolve()
    await Promise.resolve()
  })

  act(() => { tree.root.findByProps({ 'data-testid': 'project-switcher' }).props.onClick() })
  await act(async () => {
    tree.root.findByProps({ 'data-testid': 'project-new' }).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })
  await act(async () => {
    tree.root.findByProps({ 'data-testid': 'project-load-retry' }).props.onClick()
    await Promise.resolve()
    await Promise.resolve()
  })

  expect(tree.root.findByProps({ className: 'elves-stage' })).toBeTruthy()
  expect(tree.root.findByProps({ className: 'elves-switcher__name' }).children).toEqual(['Essay'])
  expect(tree.root.findAll((node) => node.children.includes('No projects yet'))).toHaveLength(0)
  expect(tree.root.findAllByProps({ 'data-testid': 'project-list-error' })).toHaveLength(0)
  await act(async () => { tree.unmount() })
})
