import { expect, test, vi } from 'vitest'
import type { Editor } from 'tldraw'
import {
  annotationResolutionIdentity, captureAnnotationCueAnchor, setAnnotationResolved,
} from '../../src/client/annotationResolution'

function editorWith(records: Record<string, any>, pin?: { key: string; rect: any }) {
  const updateShape = vi.fn((update: any) => {
    const current = records[update.id]
    records[update.id] = { ...current, props: { ...current.props, ...update.props } }
  })
  const containerBounds = { left: 100, top: 50, width: 800, height: 600 }
  const run = vi.fn((task: () => void, _options?: { history?: 'ignore' | 'record' }) => task())
  const markHistoryStoppingPoint = vi.fn()
  return {
    editor: {
      getShape: (id: string) => records[id],
      updateShape,
      run,
      markHistoryStoppingPoint,
      getContainer: () => ({
        getBoundingClientRect: () => containerBounds,
        querySelectorAll: () => pin ? [{ dataset: { annotationTarget: pin.key }, getBoundingClientRect: () => pin.rect }] : [],
      }),
    } as unknown as Editor,
    markHistoryStoppingPoint,
    run,
    updateShape,
  }
}

test('targeted card Undo changes only resolved and preserves later replies and unrelated edits', () => {
  const target = { kind: 'card' as const, cardId: 'shape:card', commentId: 'comment:one' }
  const records: Record<string, any> = {
    'shape:card': {
      id: 'shape:card', type: 'card', x: 10,
      props: { comments: [{
        id: 'comment:one', type: 'structure', text: 'Original', resolved: false,
        author: 'claude', reviewId: null, messages: [{ id: 'initial', author: 'claude', text: 'Original', createdAt: '' }],
      }] },
    },
  }
  const { editor, markHistoryStoppingPoint, run, updateShape } = editorWith(records)
  const identity = annotationResolutionIdentity(editor, target)!
  expect(setAnnotationResolved(editor, target, true, identity)).toBe(true)

  records['shape:card'].x = 77
  records['shape:card'].props.comments[0].messages.push({ id: 'later', author: 'user', text: 'Later reply', createdAt: 'later' })
  expect(setAnnotationResolved(editor, target, false, identity)).toBe(true)
  expect(records['shape:card'].x).toBe(77)
  expect(records['shape:card'].props.comments[0]).toMatchObject({
    resolved: false,
    messages: [{ id: 'initial' }, { id: 'later' }],
  })
  expect(updateShape).toHaveBeenCalledTimes(2)
  expect(run.mock.calls.map(([, options]) => options)).toEqual([
    { history: 'ignore' }, { history: 'ignore' },
  ])
  expect(markHistoryStoppingPoint.mock.calls.map(([label]) => label)).toEqual([
    'resolve annotation', 'restore annotation',
  ])
})

test('Undo safely no-ops when a target is deleted or superseded and never recreates it', () => {
  const target = { kind: 'feedback' as const, feedbackId: 'shape:feedback' }
  const records: Record<string, any> = {
    'shape:feedback': {
      id: 'shape:feedback', type: 'feedback',
      props: { type: 'weak-argument', text: 'Original', authoredBy: 'claude', reviewId: null, reviewer: 'architect', resolved: false, messages: [] },
    },
  }
  const { editor, updateShape } = editorWith(records)
  const identity = annotationResolutionIdentity(editor, target)!
  expect(setAnnotationResolved(editor, target, true, identity)).toBe(true)
  records['shape:feedback'] = { ...records['shape:feedback'], props: { ...records['shape:feedback'].props, text: 'Replacement' } }
  expect(setAnnotationResolved(editor, target, false, identity)).toBe(false)
  delete records['shape:feedback']
  expect(setAnnotationResolved(editor, target, false, identity)).toBe(false)
  expect(records['shape:feedback']).toBeUndefined()
  expect(updateShape).toHaveBeenCalledTimes(1)
})

test('floating-feedback cue geometry is captured before the pin disappears', () => {
  const target = { kind: 'feedback' as const, feedbackId: 'shape:feedback' }
  const records = {
    'shape:feedback': { id: 'shape:feedback', type: 'feedback', props: { resolved: false } },
  }
  const { editor } = editorWith(records, {
    key: 'feedback:shape:feedback',
    rect: { left: 850, right: 878, top: 620, bottom: 648, width: 28, height: 28 },
  })

  expect(captureAnnotationCueAnchor(editor, target)).toEqual({ left: 742, top: 552, side: 'left' })
})
