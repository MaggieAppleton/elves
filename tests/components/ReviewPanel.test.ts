import { createElement } from 'react'
import { create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import type { Editor } from 'tldraw'

vi.mock('tldraw', () => ({
  useValue: (_name: string, getValue: () => unknown) => getValue(),
}))

import { ReviewPanel } from '../../src/components/ReviewPanel'

test('review panel has no resolved annotation stack', () => {
  const editor = {
    getCurrentPageShapes: () => [{
      id: 'shape:card',
      type: 'card',
      props: {
        comments: [{
          id: 'comment:resolved', type: 'structure', text: 'This was addressed.',
          resolved: true, author: 'claude', messages: [],
        }],
      },
    }],
  } as unknown as Editor
  const tree = create(createElement(ReviewPanel, {
    projectId: 'essay', editor, reviews: [], disabled: false,
    onSummon: vi.fn(), onDismiss: vi.fn(), onRetry: vi.fn(),
  }))

  expect(tree.root.findAllByProps({ 'data-feedback-stack': true })).toHaveLength(0)
})
