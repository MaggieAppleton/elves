import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const tldraw = vi.hoisted(() => ({
  editor: {
    getShape: vi.fn(),
    getCamera: vi.fn(() => ({ x: 0, y: 0, z: 1 })),
    getContainer: vi.fn(() => ({
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    })),
  },
}))

vi.mock('tldraw', () => ({
  useEditor: () => tldraw.editor,
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))

import { AnnotationPopoverLayer, annotationPopoverMotion, foregroundEntries } from '../../src/components/AnnotationPopoverLayer'
import {
  annotationClosingTargets,
  clearAnnotationPresentations,
  openAnnotationThread,
  requestAnnotationClose,
  setAnnotationHover,
  setAnnotationThreadPresentation,
  subscribeAnnotationRetry,
} from '../../src/client/annotationSelection'

const failedTarget = { kind: 'feedback' as const, feedbackId: 'shape:failed' }

function failedFeedback() {
  return {
    id: failedTarget.feedbackId,
    type: 'feedback',
    props: {
      resolved: false,
      type: null,
      text: 'Retry this thread.',
      authoredBy: 'claude',
      messages: [],
    },
  }
}

function visibleRetry(tree: ReactTestRenderer) {
  const retry = tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))
  if (!retry) throw new Error('expected the foreground thread to expose Retry')
  return retry
}

beforeEach(() => {
  clearAnnotationPresentations()
  tldraw.editor.getShape.mockReturnValue(failedFeedback())
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
})

afterEach(() => {
  clearAnnotationPresentations()
  vi.unstubAllGlobals()
})

test('renders all open targets with increasing foreground order', () => {
  const targets = [
    { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' },
    { kind: 'feedback' as const, feedbackId: 'shape:b' },
  ]

  expect(foregroundEntries(targets).map((entry) => entry.zIndex)).toEqual([1, 2])
})

test('hover preview is not duplicated when its target is already open', () => {
  const target = { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' }

  expect(foregroundEntries([target], target)).toHaveLength(1)
  expect(foregroundEntries([], target)[0].mode).toBe('preview')
})

test('motion waits for final placement, skips keyboard, and cannot restart from geometry updates', () => {
  expect(annotationPopoverMotion('preview', 'pointer', false, false)).toBe('pending')
  expect(annotationPopoverMotion('preview', 'pointer', true, true)).toBe('enter')
  expect(annotationPopoverMotion('open', 'pointer', true, true)).toBe('enter')
  expect(annotationPopoverMotion('open', 'keyboard', true, true)).toBeUndefined()
  expect(annotationPopoverMotion('closing', 'pointer', true, true)).toBe('exit')
})

test('pointer closing keeps only an inert exit panel until its single timer settles', () => {
  vi.useFakeTimers()
  openAnnotationThread(failedTarget, 'pointer')
  let tree!: ReactTestRenderer
  act(() => { tree = create(createElement(AnnotationPopoverLayer)) })

  act(() => requestAnnotationClose(failedTarget, 'pointer'))
  expect(annotationClosingTargets()).toHaveLength(1)
  const closing = tree.root.findByProps({ 'data-annotation-popover-target': 'feedback:shape:failed' })
  expect(closing.props).toMatchObject({ 'data-motion': 'exit', 'aria-hidden': true })
  expect(closing.props.onPointerDown).toBeUndefined()
  expect(closing.props.onClick).toBeUndefined()
  expect(closing.props.onKeyDown).toBeUndefined()

  act(() => { vi.advanceTimersByTime(100) })
  expect(tree.root.findAllByProps({ 'data-annotation-popover-target': 'feedback:shape:failed' })).toHaveLength(0)
  act(() => tree.unmount())
  vi.useRealTimers()
})

test('re-hovering a closing target renders one preview rather than a duplicate-key exit', () => {
  const closing = [{ target: failedTarget, origin: 'pointer' as const }]
  const entries = foregroundEntries([], failedTarget, closing)
  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({ target: failedTarget, mode: 'preview' })
})

test('foreground layer wires a failed target’s visible Retry control to its exact target', () => {
  const onRetry = vi.fn()
  const unsubscribe = subscribeAnnotationRetry(onRetry)
  openAnnotationThread(failedTarget)
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'The reply stopped.' })

  let tree!: ReactTestRenderer
  act(() => { tree = create(createElement(AnnotationPopoverLayer)) })

  const retry = visibleRetry(tree)
  expect(retry.props.disabled).toBe(false)
  act(() => retry.props.onClick())
  expect(onRetry).toHaveBeenCalledOnce()
  expect(onRetry).toHaveBeenCalledWith(failedTarget)

  act(() => tree.unmount())
  unsubscribe()
})

test('foreground panels stop canvas pointer, click, and keyboard events while retaining their controls', () => {
  openAnnotationThread(failedTarget)
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'The reply stopped.' })

  let tree!: ReactTestRenderer
  act(() => { tree = create(createElement(AnnotationPopoverLayer)) })
  const panel = tree.root.findByProps({ 'data-annotation-popover-target': 'feedback:shape:failed' })

  for (const eventName of ['onPointerDown', 'onClick', 'onKeyDown'] as const) {
    const stopPropagation = vi.fn()
    panel.props[eventName]({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
  }

  const trigger = tree.root.findByProps({ className: 'elves-annotation-thread__reply-trigger' })
  act(() => trigger.props.onClick())
  const reply = tree.root.findByType('textarea')
  act(() => reply.props.onChange({ target: { value: 'Keep this draft editable.' } }))
  expect(tree.root.findByType('textarea').props.value).toBe('Keep this draft editable.')
  expect(visibleRetry(tree).props.disabled).toBe(false)

  act(() => tree.unmount())
})

test('preview panels retain the delayed hover handoff handlers', () => {
  setAnnotationHover(failedTarget)

  let tree!: ReactTestRenderer
  act(() => { tree = create(createElement(AnnotationPopoverLayer)) })
  const panel = tree.root.findByProps({ 'data-annotation-popover-target': 'feedback:shape:failed' })

  expect(panel.props.onPointerEnter).toEqual(expect.any(Function))
  expect(panel.props.onPointerLeave).toEqual(expect.any(Function))
  act(() => panel.props.onPointerEnter())
  act(() => panel.props.onPointerLeave())

  act(() => tree.unmount())
})
