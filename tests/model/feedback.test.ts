import { describe, expect, test } from 'vitest'
import { makeFeedbackProps } from '../../src/model/feedback'

describe('floating feedback props', () => {
  test('preserves agent and review provenance while starting active', () => {
    expect(makeFeedbackProps('The middle needs a bridge', 'claude', {
      type: 'structure', reviewId: 'rev-1', reviewer: 'architect',
    })).toMatchObject({
      text: 'The middle needs a bridge', authoredBy: 'claude', type: 'structure',
      reviewId: 'rev-1', reviewer: 'architect', resolved: false,
    })
  })

  test('creates generic agent feedback without inventing review provenance', () => {
    expect(makeFeedbackProps('What is the central claim?', 'codex')).toMatchObject({
      authoredBy: 'codex', type: null, reviewId: null, reviewer: null, resolved: false,
    })
  })
})
