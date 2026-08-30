import { expect, test, vi } from 'vitest'
import {
  annotationOpenTargets,
  annotationHoverTarget,
  clearAnnotationPresentations,
  closeAnnotationThread,
  openAnnotationThread,
  promoteAnnotationThread,
  requestAnnotationOpen,
  setAnnotationHover,
  subscribeAnnotationOpen,
} from '../../src/client/annotationSelection'

const a = { kind: 'card' as const, cardId: 'shape:a', commentId: 'comment:a' }
const b = { kind: 'feedback' as const, feedbackId: 'shape:b' }

test('annotation-open listeners receive the selected target once', () => {
  const receive = vi.fn()
  const unsubscribe = subscribeAnnotationOpen(receive)
  requestAnnotationOpen({ kind: 'feedback', feedbackId: 'shape:feedback' })
  expect(receive).toHaveBeenCalledTimes(1)
  expect(receive).toHaveBeenCalledWith({ kind: 'feedback', feedbackId: 'shape:feedback' })
  unsubscribe()
})

test('unsubscribed annotation-open listeners no longer receive targets', () => {
  const receive = vi.fn()
  const unsubscribe = subscribeAnnotationOpen(receive)
  unsubscribe()
  requestAnnotationOpen({ kind: 'card', cardId: 'shape:card', commentId: 'comment:one' })
  expect(receive).not.toHaveBeenCalled()
})

test('open targets are session-only, independent, and ordered by engagement', () => {
  clearAnnotationPresentations()
  openAnnotationThread(a)
  openAnnotationThread(b)
  expect(annotationOpenTargets()).toEqual([a, b])
  promoteAnnotationThread(a)
  expect(annotationOpenTargets()).toEqual([b, a])
  closeAnnotationThread(a)
  expect(annotationOpenTargets()).toEqual([b])
})

test('hover target is temporary and separate from open targets', () => {
  clearAnnotationPresentations()
  setAnnotationHover(a)
  expect(annotationHoverTarget()).toEqual(a)
  expect(annotationOpenTargets()).toEqual([])
  setAnnotationHover(null)
  expect(annotationHoverTarget()).toBeNull()
})
