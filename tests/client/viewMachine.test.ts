import { expect, test } from 'vitest'
import {
  VIEW_ORDER,
  moreDraft,
  lessDraft,
  canExpand,
  canCollapse,
} from '../../src/client/viewMachine'

test('VIEW_ORDER is canvas → split → draft', () => {
  expect(VIEW_ORDER).toEqual(['canvas', 'split', 'draft'])
})

test('moreDraft steps one toward draft and clamps at draft', () => {
  expect(moreDraft('canvas')).toBe('split')
  expect(moreDraft('split')).toBe('draft')
  expect(moreDraft('draft')).toBe('draft')
})

test('lessDraft steps one toward canvas and clamps at canvas', () => {
  expect(lessDraft('draft')).toBe('split')
  expect(lessDraft('split')).toBe('canvas')
  expect(lessDraft('canvas')).toBe('canvas')
})

test('canExpand is false only at draft; canCollapse is false only at canvas', () => {
  expect(canExpand('canvas')).toBe(true)
  expect(canExpand('split')).toBe(true)
  expect(canExpand('draft')).toBe(false)
  expect(canCollapse('canvas')).toBe(false)
  expect(canCollapse('split')).toBe(true)
  expect(canCollapse('draft')).toBe(true)
})
