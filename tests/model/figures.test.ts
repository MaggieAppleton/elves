import { describe, expect, test } from 'vitest'
import { FIGURE_STATUSES, nextFigureStatus } from '../../src/model/figures'

describe('figure status cycle', () => {
  test('the three statuses are idea → sketched → final', () => {
    expect(FIGURE_STATUSES).toEqual(['idea', 'sketched', 'final'])
  })

  test('clicking the chip advances one step', () => {
    expect(nextFigureStatus('idea')).toBe('sketched')
    expect(nextFigureStatus('sketched')).toBe('final')
  })

  test('final wraps back to idea, so the chip is a simple three-way cycle', () => {
    expect(nextFigureStatus('final')).toBe('idea')
  })

  test('a full cycle returns to the start', () => {
    let s: ReturnType<typeof nextFigureStatus> = 'idea'
    s = nextFigureStatus(s)
    s = nextFigureStatus(s)
    s = nextFigureStatus(s)
    expect(s).toBe('idea')
  })
})
