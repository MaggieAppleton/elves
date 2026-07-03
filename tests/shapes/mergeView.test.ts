import { beforeEach, expect, test } from 'vitest'
import type { TLShape } from 'tldraw'
import {
  isExpanded, toggleExpanded, collapseAll, cardIsHidden, mergedMembers,
} from '../../src/shapes/mergeView'

// Minimal shape stand-ins — only `type` and `props.mergedInto` are read.
function card(id: string, mergedInto: string | null = null): TLShape {
  return { id, type: 'card', props: { mergedInto } } as unknown as TLShape
}
function section(id: string): TLShape {
  return { id, type: 'section', props: {} } as unknown as TLShape
}

beforeEach(() => collapseAll())

test('toggleExpanded flips a representative in and out of the peek', () => {
  expect(isExpanded('rep')).toBe(false)
  toggleExpanded('rep')
  expect(isExpanded('rep')).toBe(true)
  toggleExpanded('rep')
  expect(isExpanded('rep')).toBe(false)
})

test('expansions are independent per representative', () => {
  toggleExpanded('a')
  expect(isExpanded('a')).toBe(true)
  expect(isExpanded('b')).toBe(false)
})

test('collapseAll dismisses every open peek', () => {
  toggleExpanded('a')
  toggleExpanded('b')
  collapseAll()
  expect(isExpanded('a')).toBe(false)
  expect(isExpanded('b')).toBe(false)
})

test('cardIsHidden is true only for a merged-away source card', () => {
  expect(cardIsHidden(card('rep', null))).toBe(false)
  expect(cardIsHidden(card('dupe', 'rep'))).toBe(true)
  // A merge pointer only exists on cards; other shapes are never hidden by it.
  expect(cardIsHidden(section('sec'))).toBe(false)
})

test('mergedMembers returns the cards merged into a given representative', () => {
  const shapes = [
    card('rep', null),
    card('m1', 'rep'),
    card('m2', 'rep'),
    card('other', 'rep2'),
    section('sec'),
  ]
  const members = mergedMembers(shapes, 'rep')
  expect(members.map((s) => s.id)).toEqual(['m1', 'm2'])
})
