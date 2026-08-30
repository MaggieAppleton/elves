import { expect, test, vi } from 'vitest'
import { requestAnnotationOpen, subscribeAnnotationOpen } from '../../src/client/annotationSelection'

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
