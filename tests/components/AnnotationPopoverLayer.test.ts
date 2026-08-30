import { expect, test } from 'vitest'
import { foregroundEntries } from '../../src/components/AnnotationPopoverLayer'

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
