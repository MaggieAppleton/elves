import { describe, expect, test } from 'vitest'
import { cascadeOffset, CASCADE_STEP, CASCADE_WRAP } from '../../src/model/layout'

describe('cascadeOffset', () => {
  test('first spawn has no offset', () => {
    expect(cascadeOffset(0)).toEqual({ dx: 0, dy: 0 })
  })

  test('consecutive spawns get distinct offsets', () => {
    const a = cascadeOffset(0)
    const b = cascadeOffset(1)
    expect(a).not.toEqual(b)
    expect(b).toEqual({ dx: CASCADE_STEP, dy: CASCADE_STEP })
  })

  test('wraps back to zero after CASCADE_WRAP steps so cards do not drift off-screen', () => {
    expect(cascadeOffset(CASCADE_WRAP)).toEqual({ dx: 0, dy: 0 })
    expect(cascadeOffset(CASCADE_WRAP + 1)).toEqual(cascadeOffset(1))
  })
})
