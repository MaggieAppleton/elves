import { expect, test } from 'vitest'
import { annotationPin, cardAnnotationPins } from '../../src/model/annotationPins'

test('structure has a stable branch icon and colour token', () => {
  expect(annotationPin('structure')).toEqual({ icon: 'branch', tone: 'structure', label: 'Structure' })
})

test('card pins are one-per-comment and vertically non-overlapping', () => {
  expect(cardAnnotationPins([{ id: 'a' }, { id: 'b' }] as any)).toEqual([
    { commentId: 'a', offsetY: 0 }, { commentId: 'b', offsetY: 36 },
  ])
})

test('every comment type has a readable stable pin token', () => {
  expect(annotationPin(null)).toEqual({ icon: 'message', tone: 'freeform', label: 'Comment' })
  expect(annotationPin('needs-evidence')).toEqual({ icon: 'quote', tone: 'needs-evidence', label: 'Needs evidence' })
  expect(annotationPin('weak-argument')).toEqual({ icon: 'warning', tone: 'weak-argument', label: 'Weak argument' })
  expect(annotationPin('needs-citation')).toEqual({ icon: 'link', tone: 'needs-citation', label: 'Needs citation' })
  expect(annotationPin('wants-figure')).toEqual({ icon: 'image', tone: 'wants-figure', label: 'Wants figure' })
  expect(annotationPin('counterpoint')).toEqual({ icon: 'arrows', tone: 'counterpoint', label: 'Counterpoint' })
  expect(annotationPin('tighten')).toEqual({ icon: 'scissors', tone: 'tighten', label: 'Tighten' })
  expect(annotationPin('unclear')).toEqual({ icon: 'question', tone: 'unclear', label: 'Unclear' })
})

test('card pin placement is deterministic and handles an empty card', () => {
  expect(cardAnnotationPins([])).toEqual([])
  expect(cardAnnotationPins([{ id: 'b' }, { id: 'a' }, { id: 'b' }])).toEqual([
    { commentId: 'b', offsetY: 0 },
    { commentId: 'a', offsetY: 36 },
    { commentId: 'b', offsetY: 72 },
  ])
})
