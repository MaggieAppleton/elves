import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AnnotationThread } from '../../src/components/AnnotationThread'

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
