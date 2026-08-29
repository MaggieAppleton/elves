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
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-thread' })).toHaveLength(2)
})

test('feedback rail projects persisted messages instead of only its legacy text', () => {
  const feedbackEditor = {
    getShape: () => ({
      id: 'shape:feedback', type: 'feedback', props: {
        text: 'Initial feedback', authoredBy: 'claude', type: null, reviewer: null, resolved: false,
        messages: [
          { id: 'claude-1', author: 'claude', text: 'Initial feedback', createdAt: 'T0' },
          { id: 'user-1', author: 'user', text: 'Can you clarify?', createdAt: 'T1' },
        ],
      },
    }),
  } as unknown as Editor
  const tree = create(createElement(AnnotationRail, {
    target: { kind: 'feedback', feedbackId: 'shape:feedback' }, editor: feedbackEditor,
    onClose: vi.fn(), onResolve: vi.fn(), onRestore: vi.fn(),
  }))

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(JSON.stringify(tree.toJSON())).toContain('Can you clarify?')
})
