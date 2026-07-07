import { expect, test } from 'vitest'
import { shapeRecordsById, diffChangedIds, type RecordLike } from '../../src/client/resync'

const shape = (id: string, extra: Record<string, unknown> = {}): RecordLike => ({
  id, typeName: 'shape', ...extra,
})

test('shapeRecordsById keeps only shape records, keyed by id', () => {
  const map = shapeRecordsById([
    shape('shape:a'),
    { id: 'page:1', typeName: 'page' },
    shape('shape:b', { x: 1 }),
  ])
  expect([...map.keys()]).toEqual(['shape:a', 'shape:b'])
  expect(map.get('shape:b')).toEqual(shape('shape:b', { x: 1 }))
})

test('diffChangedIds finds ids new in `after` that are absent from `before`', () => {
  const before = shapeRecordsById([shape('shape:a')])
  const after = shapeRecordsById([shape('shape:a'), shape('shape:b')])
  // Mirrors the real bug: an agent-created card (server id A) shows up after a
  // resync as a brand-new id, not present before the reload.
  expect(diffChangedIds(before, after)).toEqual(['shape:b'])
})

test('diffChangedIds finds ids whose record content changed', () => {
  const before = shapeRecordsById([shape('shape:a', { x: 0 })])
  const after = shapeRecordsById([shape('shape:a', { x: 100 })])
  expect(diffChangedIds(before, after)).toEqual(['shape:a'])
})

test('diffChangedIds is empty when nothing changed', () => {
  const before = shapeRecordsById([shape('shape:a', { x: 0 }), shape('shape:b')])
  const after = shapeRecordsById([shape('shape:a', { x: 0 }), shape('shape:b')])
  expect(diffChangedIds(before, after)).toEqual([])
})

test('diffChangedIds ignores ids removed in `after` (deletes never glow)', () => {
  const before = shapeRecordsById([shape('shape:a'), shape('shape:b')])
  const after = shapeRecordsById([shape('shape:a')])
  expect(diffChangedIds(before, after)).toEqual([])
})
