import { expect, test, vi } from 'vitest'
import {
  annotationReplyDraft,
  annotationOpenTargets,
  annotationHoverTarget,
  clearAnnotationPresentations,
  clearAnnotationReplyDraft,
  closeAnnotationThread,
  dismissAnnotationPopoverSoon,
  openAnnotationThread,
  promoteAnnotationThread,
  pruneAnnotationThreads,
  requestAnnotationClose,
  requestAnnotationOpen,
  requestAnnotationResolve,
  setAnnotationReplyDraft,
  setAnnotationHover,
  subscribeAnnotationResolve,
} from '../../src/client/annotationSelection'

const a = { kind: 'card' as const, cardId: 'shape:a', commentId: 'comment:a' }
const b = { kind: 'feedback' as const, feedbackId: 'shape:b' }

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

test('closing one open target leaves the other target open', () => {
  clearAnnotationPresentations()
  openAnnotationThread(a)
  openAnnotationThread(b)

  requestAnnotationClose(a)

  expect(annotationOpenTargets()).toEqual([b])
})

test('reply drafts are session-only and isolated by exact annotation target', () => {
  clearAnnotationPresentations()
  setAnnotationReplyDraft(a, 'Card draft')
  setAnnotationReplyDraft(b, 'Feedback draft')

  expect(annotationReplyDraft(a)).toBe('Card draft')
  expect(annotationReplyDraft(b)).toBe('Feedback draft')
  closeAnnotationThread(a)
  expect(annotationReplyDraft(a)).toBe('Card draft')
  clearAnnotationReplyDraft(a)
  expect(annotationReplyDraft(a)).toBe('')
  expect(annotationReplyDraft(b)).toBe('Feedback draft')

  clearAnnotationPresentations()
  expect(annotationReplyDraft(b)).toBe('')
})

test('resolve requests notify listeners for only their target', () => {
  const receive = vi.fn()
  const unsubscribe = subscribeAnnotationResolve(receive)

  requestAnnotationResolve(a)

  expect(receive).toHaveBeenCalledOnce()
  expect(receive).toHaveBeenCalledWith(a)
  unsubscribe()
})

test('pruning missing targets preserves other open threads', () => {
  clearAnnotationPresentations()
  openAnnotationThread(a)
  openAnnotationThread(b)

  pruneAnnotationThreads((target) => target.kind === 'feedback')

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

test('opening a hovered target clears its hover state', () => {
  clearAnnotationPresentations()
  setAnnotationHover(a)
  requestAnnotationOpen(a)
  expect(annotationOpenTargets()).toEqual([a])
  expect(annotationHoverTarget()).toBeNull()
})

test('re-entering a hover target cancels its pending dismissal', () => {
  vi.useFakeTimers()
  clearAnnotationPresentations()
  setAnnotationHover(a)
  dismissAnnotationPopoverSoon(a)
  setAnnotationHover(a)
  vi.advanceTimersByTime(100)
  expect(annotationHoverTarget()).toEqual(a)
  vi.useRealTimers()
  clearAnnotationPresentations()
})
