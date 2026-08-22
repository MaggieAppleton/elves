import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import type { Editor } from 'tldraw'

vi.mock('tldraw', () => ({
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))

import { AnnotationRail } from '../../src/components/AnnotationRail'

const editor = {
  getShape: () => ({
    id: 'shape:card',
    type: 'card',
    props: {
      comments: [
        { id: 'c1', type: 'structure', text: 'Give the middle a clearer bridge.', resolved: false, author: 'claude' },
        { id: 'c2', type: null, text: 'A second, still-open observation.', resolved: false, author: 'architect' },
        { id: 'c3', type: 'tighten', text: 'Already handled.', resolved: true, author: 'claude' },
      ],
    },
  }),
} as unknown as Editor

test('card target lists its open comments and renders no reply input', () => {
  const tree = create(createElement(AnnotationRail, {
    target: { kind: 'card', cardId: 'shape:card', commentId: 'c1' },
    editor,
    onClose: vi.fn(),
    onResolve: vi.fn(),
    onRestore: vi.fn(),
  }))

  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-rail' })).toHaveLength(1)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-item' })).toHaveLength(2)
})
