import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AnnotationPin, AnnotationThread } from '../../src/components/AnnotationThread'
import { setAnnotationThreadPresentation } from '../../src/client/annotationSelection'

test('popover exposes the complete read-only thread without a reply input', () => {
  const onResolve = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1',
      type: 'structure',
      text: 'Give the middle a clearer bridge.',
      resolved: false,
      author: 'claude',
    },
    mode: 'popover',
    onResolve,
  }))

  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-thread' })).toHaveLength(1)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__text' })[0].children).toContain('Give the middle a clearer bridge.')
  const resolve = tree.root.findByProps({ className: 'elves-annotation-thread__resolve' })
  expect(resolve.props['aria-label']).toBe('Resolve Structure comment')
  resolve.props.onClick()
  expect(onResolve).toHaveBeenCalledOnce()
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

test('pin popover receives thread-local progress, error, and retry state', () => {
  const retry = vi.fn()
  const target = { kind: 'card' as const, cardId: 'shape:card', commentId: 'c1' }
  setAnnotationThreadPresentation(target, {
    running: true, streamingText: 'Looking for the source…', error: 'The run stopped.',
  })
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    target,
    onOpen: vi.fn(),
    onReply: vi.fn(),
    onRetry: retry,
  }))

  const popover = tree.root.findByProps({ 'data-testid': 'annotation-popover' })
  expect(JSON.stringify(tree.toJSON())).toContain('Looking for the source…')
  expect(JSON.stringify(tree.toJSON())).toContain('The run stopped.')
  expect(popover.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
  popover.findAllByType('button').find((button) => button.children.includes('Retry'))!.props.onClick()
  expect(retry).toHaveBeenCalledWith(target)
  setAnnotationThreadPresentation(target, null)
})
