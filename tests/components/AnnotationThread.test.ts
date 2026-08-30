import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AnnotationPin, AnnotationThread } from '../../src/components/AnnotationThread'
import { annotationHoverTarget, setAnnotationHover } from '../../src/client/annotationSelection'

test('preview mode renders every message but no interactive control', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: 'structure', text: 'Initial finding', resolved: false, author: 'claude',
      messages: [
        { id: 'm1', author: 'claude', text: 'Initial finding', createdAt: '2026-08-30T09:00:00Z' },
        { id: 'm2', author: 'user', text: 'What would fix it?', createdAt: '2026-08-30T09:01:00Z' },
      ],
    },
    mode: 'preview',
  }))

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByType('button')).toHaveLength(0)
})

test('open mode exposes reply, retry, resolve, and close actions', () => {
  const onClose = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onClose, onResolve: vi.fn(), onReply: vi.fn(),
    error: 'The reply stopped.', onRetry: vi.fn(),
  }))

  expect(tree.root.findByType('textarea')).toBeTruthy()
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props['aria-label'])
    .toBe('Close annotation thread')
  expect(tree.root.findAllByType('button').some((button) => button.children.includes('Retry'))).toBe(true)
  tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props.onClick()
  expect(onClose).toHaveBeenCalledOnce()
})

test('legacy popover mode retains read-only preview semantics', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1',
      type: 'structure',
      text: 'Give the middle a clearer bridge.',
      resolved: false,
      author: 'claude',
    },
    mode: 'popover',
  }))

  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-thread' })).toHaveLength(1)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__text' })[0].children).toContain('Give the middle a clearer bridge.')
  expect(tree.root.findAllByType('button')).toHaveLength(0)
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
    mode: 'rail',
    running: true,
    onResolve: vi.fn(),
    onReply: vi.fn(),
  }))

  expect(tree.root.findAllByType('textarea')).toHaveLength(1)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__resolve' }).props.disabled).toBe(false)
})

test('a restored card retains a comment action name', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: 'needs-evidence', text: 'Needs a source', resolved: true, author: 'claude' },
    mode: 'rail', actionLabel: 'Restore comment', onResolve: vi.fn(),
  }))

  expect(tree.root.findByProps({ className: 'elves-annotation-thread__resolve' }).props['aria-label'])
    .toBe('Restore Needs evidence comment')
})

test('hovering a targeted pin stores its preview target in the session state', () => {
  const target = { kind: 'feedback' as const, feedbackId: 'shape:feedback' }
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'feedback', type: 'weak-argument', text: 'Name the causal bridge.', resolved: false, author: 'claude' },
    target,
  }))

  const pin = tree.root.findByProps({ className: 'elves-annotation-pin-wrap' })
  expect(pin.props.onPointerEnter).toEqual(expect.any(Function))
  act(() => pin.props.onPointerEnter())
  expect(annotationHoverTarget()).toEqual(target)
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-popover' })).toHaveLength(0)
  setAnnotationHover(null)
})

test('a canvas lock disables a populated reply form without discarding its draft', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'rail', onResolve: vi.fn(), onReply: vi.fn(),
  }))
  const textarea = tree.root.findByType('textarea')
  act(() => textarea.props.onChange({ target: { value: 'My saved draft' } }))
  act(() => tree.update(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'rail', disabled: true, onResolve: vi.fn(), onReply: vi.fn(),
  })))
  expect(tree.root.findByType('textarea').props).toMatchObject({ value: 'My saved draft', disabled: true })
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
})

test('a pin name includes a bounded gist of the annotation text', () => {
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'c1', type: null, text: 'Name the causal bridge explicitly.', resolved: false, author: 'claude' },
  }))
  expect(tree.root.findByProps({ 'data-testid': 'annotation-pin' }).props['aria-label']).toContain('Name the causal bridge explicitly.')
})
