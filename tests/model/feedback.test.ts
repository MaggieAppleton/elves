import { describe, expect, test } from 'vitest'
import { FEEDBACK_DEFAULT_H, FEEDBACK_DEFAULT_W, feedbackIsHidden, makeFeedbackProps } from '../../src/model/feedback'

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

  test('uses compact point geometry and initializes a durable thread', () => {
    expect(makeFeedbackProps('Pin')).toMatchObject({
      w: FEEDBACK_DEFAULT_W, h: FEEDBACK_DEFAULT_H, messages: [],
    })
    expect(FEEDBACK_DEFAULT_W).toBe(28)
    expect(FEEDBACK_DEFAULT_H).toBe(28)
  })

  test('hides only resolved feedback from the active canvas', () => {
    expect(feedbackIsHidden({ type: 'feedback', props: { resolved: true } })).toBe(true)
    expect(feedbackIsHidden({ type: 'feedback', props: { resolved: false } })).toBe(false)
    expect(feedbackIsHidden({ type: 'card', props: { resolved: true } })).toBe(false)
  })
})
