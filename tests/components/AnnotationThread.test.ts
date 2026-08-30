import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AnnotationPin, AnnotationThread } from '../../src/components/AnnotationThread'
import {
  annotationHoverTarget, clearAnnotationPresentations, setAnnotationThreadPresentation,
  subscribeAnnotationReply, subscribeAnnotationRetry,
} from '../../src/client/annotationSelection'
import { foregroundThreadProps } from '../../src/components/AnnotationPopoverLayer'

test('preview has no reply, retry, resolve, or close controls', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: 'structure', text: 'Initial finding', resolved: false, author: 'claude',
      messages: [
        { id: 'm1', author: 'claude', text: 'Initial finding', createdAt: '2026-08-30T09:00:00Z' },
        { id: 'm2', author: 'user', text: 'What would fix it?', createdAt: '2026-08-30T09:01:00Z' },
      ],
    },
    mode: 'preview',
    error: 'The reply stopped.',
    onReply: vi.fn(),
    onRetry: vi.fn(),
    onResolve: vi.fn(),
    onClose: vi.fn(),
  }))

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByType('button')).toHaveLength(0)
})

test('open mode exposes reply, retry, resolve, and close actions', () => {
  const onClose = vi.fn()
  const onResolve = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onClose, onResolve, onReply: vi.fn(),
    error: 'The reply stopped.', onRetry: vi.fn(),
  }))

  expect(tree.root.findByType('textarea')).toBeTruthy()
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props['aria-label'])
    .toBe('Close annotation thread')
  const resolve = tree.root.findByProps({ className: 'elves-annotation-thread__resolve' })
  expect(resolve.props['aria-label']).toBe('Resolve Comment comment')
  expect(tree.root.findAllByType('button').some((button) => button.children.includes('Retry'))).toBe(true)
  resolve.props.onClick()
  expect(onResolve).toHaveBeenCalledOnce()
  tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props.onClick()
  expect(onClose).toHaveBeenCalledOnce()
})

test('thread renders durable replies and only disables its own send control while running', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude',
      messages: [
        { id: 'claude-1', author: 'claude', text: 'Needs evidence', createdAt: '2026-08-29T11:00:00.000Z' },
        { id: 'user-1', author: 'user', text: 'Which source?', createdAt: '2026-08-29T12:00:00.000Z' },
      ],
    },
    mode: 'open',
    running: true,
    onResolve: vi.fn(),
    onReply: vi.fn(),
  }))

  expect(tree.root.findAllByType('textarea')).toHaveLength(1)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__resolve' }).props.disabled).toBe(false)
})

test('simultaneous threads keep reply state isolated', () => {
  const tree = create(createElement('div', {},
    createElement(AnnotationThread, {
      comment: { id: 'a', type: null, text: 'Finding', resolved: false, author: 'claude' },
      mode: 'open', running: true, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn(),
    }),
    createElement(AnnotationThread, {
      comment: { id: 'b', type: null, text: 'Finding', resolved: false, author: 'claude' },
      mode: 'open', running: false, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn(),
    }),
  ))

  const sends = tree.root.findAllByProps({ className: 'elves-annotation-thread__send' })
  act(() => tree.root.findAllByType('textarea')[1].props.onChange({ target: { value: 'A reply' } }))
  expect(sends).toHaveLength(2)
  expect(sends[0].props.disabled).toBe(true)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__send' })[1].props.disabled).toBe(false)
})

test('foreground thread props consume only their target presentation', () => {
  const runningTarget = { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' }
  const failedTarget = { kind: 'feedback' as const, feedbackId: 'shape:b' }
  clearAnnotationPresentations()
  setAnnotationThreadPresentation(runningTarget, { running: true, streamingText: 'One reply' })
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'Second reply failed' })

  expect(foregroundThreadProps(runningTarget)).toMatchObject({
    running: true, streamingText: 'One reply', error: undefined,
  })
  expect(foregroundThreadProps(failedTarget)).toMatchObject({
    running: false, streamingText: undefined, error: 'Second reply failed',
  })
  const onReply = vi.fn()
  const onRetry = vi.fn()
  const unsubscribeReply = subscribeAnnotationReply(onReply)
  const unsubscribeRetry = subscribeAnnotationRetry(onRetry)
  foregroundThreadProps(failedTarget).onReply?.('Retry this point')
  foregroundThreadProps(failedTarget).onRetry?.()
  expect(onReply).toHaveBeenCalledWith(failedTarget, 'Retry this point')
  expect(onRetry).toHaveBeenCalledWith(failedTarget)
  unsubscribeReply()
  unsubscribeRetry()
  clearAnnotationPresentations()
})

test('a rendered foreground retry action sends only its failed target', () => {
  const failedTarget = { kind: 'feedback' as const, feedbackId: 'shape:failed' }
  const onRetry = vi.fn()
  clearAnnotationPresentations()
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'The reply stopped.' })
  const unsubscribeRetry = subscribeAnnotationRetry(onRetry)

  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'failed', type: null, text: 'Retry this thread', resolved: false, author: 'claude' },
    mode: 'open',
    ...foregroundThreadProps(failedTarget),
  }))
  const retry = tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))
  expect(retry).toBeTruthy()
  retry!.props.onClick()
  expect(onRetry).toHaveBeenCalledWith(failedTarget)

  unsubscribeRetry()
  clearAnnotationPresentations()
})

test('a targeted pin clears its temporary preview after pointer or focus leaves', () => {
  vi.useFakeTimers()
  const target = { kind: 'feedback' as const, feedbackId: 'shape:feedback' }
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'feedback', type: 'weak-argument', text: 'Name the causal bridge.', resolved: false, author: 'claude' },
    target,
  }))

  const pin = tree.root.findByProps({ className: 'elves-annotation-pin-wrap' })
  expect(pin.props.onPointerEnter).toEqual(expect.any(Function))
  act(() => pin.props.onPointerEnter())
  expect(annotationHoverTarget()).toEqual(target)
  act(() => pin.props.onPointerLeave())
  act(() => { vi.advanceTimersByTime(100) })
  expect(annotationHoverTarget()).toBeNull()

  act(() => pin.props.onFocus())
  expect(annotationHoverTarget()).toEqual(target)
  act(() => pin.props.onBlur())
  act(() => { vi.advanceTimersByTime(100) })
  expect(annotationHoverTarget()).toBeNull()
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-popover' })).toHaveLength(0)
  vi.useRealTimers()
})

test('a canvas lock disables a populated reply form without discarding its draft', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onResolve: vi.fn(), onReply: vi.fn(),
  }))
  const textarea = tree.root.findByType('textarea')
  act(() => textarea.props.onChange({ target: { value: 'My saved draft' } }))
  act(() => tree.update(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', disabled: true, onResolve: vi.fn(), onReply: vi.fn(),
  })))
  expect(tree.root.findByType('textarea').props).toMatchObject({ value: 'My saved draft', disabled: true })
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
})

test('retry is unavailable while its thread is running or canvas mutations are locked', () => {
  const onRetry = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', error: 'The reply stopped.', onRetry,
    running: true,
  }))
  const retry = () => tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))!

  expect(retry().props.disabled).toBe(true)
  retry().props.onClick()
  expect(onRetry).not.toHaveBeenCalled()
  act(() => tree.update(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', error: 'The reply stopped.', onRetry: vi.fn(),
    disabled: true,
  })))
  expect(retry().props.disabled).toBe(true)
})

test('a foreground thread accepts the stage-relative height cap that bounds its transcript', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', maxHeight: 404,
  }))

  expect(tree.root.findByProps({ 'data-testid': 'annotation-thread' }).props.style).toMatchObject({ maxHeight: 404 })
})

test('a pin name includes a bounded gist of the annotation text', () => {
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'c1', type: null, text: 'Name the causal bridge explicitly.', resolved: false, author: 'claude' },
  }))
  expect(tree.root.findByProps({ 'data-testid': 'annotation-pin' }).props['aria-label']).toContain('Name the causal bridge explicitly.')
})
