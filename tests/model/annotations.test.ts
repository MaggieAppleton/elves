import { expect, test } from 'vitest'
import {
  attachedAnnotationMarker,
  annotationDisplayMode,
  feedbackAnnotationMarker,
} from '../../src/model/annotations'

test('attached marker uses first unresolved comment, a bounded gist and total count', () => {
  expect(attachedAnnotationMarker([
    { id: 'one', type: 'needs-evidence', text: 'Needs a source.', resolved: false },
    { id: 'two', type: 'tighten', text: 'Second', resolved: false },
    { id: 'three', type: null, text: 'Resolved', resolved: true },
  ] as any)).toEqual({ type: 'needs-evidence', label: 'Needs a source.', count: 2 })
})

test('attached marker prefers a model comment summary and bounds its label', () => {
  const summary = 'A concise model summary.'
  expect(attachedAnnotationMarker([
    { type: 'structure', text: 'Long source text', summary, resolved: false },
  ] as any)).toEqual({ type: 'structure', label: summary, count: 1 })

  const longText = 'word '.repeat(30)
  expect(attachedAnnotationMarker([{ type: null, text: longText, resolved: false }] as any)!.label.length).toBeLessThanOrEqual(48)
})

test('all-resolved comments have no marker', () => {
  expect(attachedAnnotationMarker([
    { type: 'tighten', text: 'Done', resolved: true },
  ] as any)).toBeNull()
})

test('overview mode starts at the existing gist threshold', () => {
  expect(annotationDisplayMode(0.6)).toBe('overview')
  expect(annotationDisplayMode(0.61)).toBe('detail')
})

test('resolved feedback has no marker', () => {
  expect(feedbackAnnotationMarker({ text: 'Done', type: 'structure', resolved: true } as any)).toBeNull()
})

test('open feedback marker uses its type, bounded gist and count one', () => {
  expect(feedbackAnnotationMarker({ text: 'A floating observation', type: null, resolved: false } as any)).toEqual({
    type: null,
    label: 'A floating observation',
    count: 1,
  })
})
