import { describe, expect, test } from 'vitest'
import { isElementWidthTransitionEnd } from '../../src/client/motion'

describe('isElementWidthTransitionEnd', () => {
  test('true only for the given element and the width property', () => {
    const pane = {} as EventTarget
    expect(isElementWidthTransitionEnd({ target: pane, propertyName: 'width' }, pane)).toBe(true)
  })

  test('false for a different property on the same element', () => {
    const pane = {} as EventTarget
    expect(isElementWidthTransitionEnd({ target: pane, propertyName: 'opacity' }, pane)).toBe(false)
  })

  test('false for an unrelated element bubbling up (e.g. a child transition)', () => {
    const pane = {} as EventTarget
    const child = {} as EventTarget
    expect(isElementWidthTransitionEnd({ target: child, propertyName: 'width' }, pane)).toBe(false)
  })
})
