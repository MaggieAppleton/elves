import { describe, expect, test } from 'vitest'
import {
  PERSONALITIES, PERSONALITY_IDS, isPersonalityId, isReviewStatus, isReview, makeReview,
  canTransition, composeBrief, type Review, type ReviewStatus,
} from '../../src/model/reviews'
import { isChangeSet } from '../../src/model/changeset'

const ALL_STATUSES: ReviewStatus[] = ['pending', 'in-progress', 'done', 'dismissed']

describe('PERSONALITIES', () => {
  test('has exactly 5 entries, one per PersonalityId', () => {
    expect(PERSONALITY_IDS).toHaveLength(5)
    expect(Object.keys(PERSONALITIES)).toHaveLength(5)
    expect(PERSONALITY_IDS.sort()).toEqual(
      ['architect', 'devils-advocate', 'fact-checker', 'first-reader', 'trimmer'].sort(),
    )
  })

  test('each entry\'s id key matches its own id field', () => {
    for (const id of PERSONALITY_IDS) {
      expect(PERSONALITIES[id].id).toBe(id)
    }
  })

  test('budgets are positive where the personality asks questions, and comment budgets are always positive', () => {
    for (const id of PERSONALITY_IDS) {
      const p = PERSONALITIES[id]
      expect(p.maxComments).toBeGreaterThan(0)
      expect(p.maxQuestions).toBeGreaterThanOrEqual(0)
    }
  })

  test('trimmer and fact-checker never ask questions (maxQuestions 0)', () => {
    expect(PERSONALITIES.trimmer.maxQuestions).toBe(0)
    expect(PERSONALITIES['fact-checker'].maxQuestions).toBe(0)
  })

  test('the other three personalities do carry a question budget', () => {
    expect(PERSONALITIES['devils-advocate'].maxQuestions).toBeGreaterThan(0)
    expect(PERSONALITIES['first-reader'].maxQuestions).toBeGreaterThan(0)
    expect(PERSONALITIES.architect.maxQuestions).toBeGreaterThan(0)
  })

  test('every personality\'s commentTypes are valid CommentTypes accepted by the change-set validator', () => {
    for (const id of PERSONALITY_IDS) {
      for (const type of PERSONALITIES[id].commentTypes) {
        const cs = { id: 'x', author: 'claude', ops: [{ kind: 'add_comment', cardId: 'a', comment: { type, text: 'note' } }] }
        expect(isChangeSet(cs)).toBe(true)
      }
    }
  })

  test('commentTypes are non-empty and each personality has a non-empty brief/summary/name', () => {
    for (const id of PERSONALITY_IDS) {
      const p = PERSONALITIES[id]
      expect(p.commentTypes.length).toBeGreaterThan(0)
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.summary.length).toBeGreaterThan(0)
      expect(p.brief.length).toBeGreaterThan(0)
    }
  })
})

describe('isPersonalityId', () => {
  test('accepts every known id, rejects junk', () => {
    for (const id of PERSONALITY_IDS) expect(isPersonalityId(id)).toBe(true)
    expect(isPersonalityId('editor')).toBe(false)
    expect(isPersonalityId(42)).toBe(false)
    expect(isPersonalityId(null)).toBe(false)
  })
})

describe('isReviewStatus', () => {
  test('accepts every known status, rejects junk', () => {
    for (const s of ALL_STATUSES) expect(isReviewStatus(s)).toBe(true)
    expect(isReviewStatus('claimed')).toBe(false)
    expect(isReviewStatus(1)).toBe(false)
  })
})

describe('makeReview', () => {
  test('defaults to pending, unclaimed, unfocused, zero comments', () => {
    const r = makeReview('rev-1', 'devils-advocate', '2026-07-08T10:00:00.000Z')
    expect(r).toEqual({
      id: 'rev-1',
      personality: 'devils-advocate',
      status: 'pending',
      focus: null,
      requestedAt: '2026-07-08T10:00:00.000Z',
      agent: null,
      startedAt: null,
      completedAt: null,
      verdict: null,
      commentCount: 0,
    })
  })

  test('carries an explicit focus note through', () => {
    const r = makeReview('rev-2', 'trimmer', '2026-07-08T10:00:00.000Z', 'just the opening section')
    expect(r.focus).toBe('just the opening section')
  })
})

describe('canTransition', () => {
  const matrix: [ReviewStatus, ReviewStatus, boolean][] = [
    // from pending
    ['pending', 'in-progress', true],
    ['pending', 'dismissed', true],
    ['pending', 'done', false],
    ['pending', 'pending', false],
    // from in-progress
    ['in-progress', 'done', true],
    ['in-progress', 'dismissed', true],
    ['in-progress', 'pending', false],
    ['in-progress', 'in-progress', false],
    // from done
    ['done', 'dismissed', true],
    ['done', 'pending', false],
    ['done', 'in-progress', false],
    ['done', 'done', false],
    // from dismissed — a terminal state, nothing leaves it (including itself)
    ['dismissed', 'pending', false],
    ['dismissed', 'in-progress', false],
    ['dismissed', 'done', false],
    ['dismissed', 'dismissed', false],
  ]

  test.each(matrix)('%s → %s is %s', (from, to, expected) => {
    expect(canTransition(from, to)).toBe(expected)
  })

  test('exhaustively covers every (from, to) pair in the matrix above', () => {
    expect(matrix).toHaveLength(ALL_STATUSES.length * ALL_STATUSES.length)
  })
})

describe('isReview', () => {
  test('accepts a round-tripped makeReview', () => {
    const r = makeReview('rev-1', 'architect', '2026-07-08T10:00:00.000Z', 'the ending')
    expect(isReview(r)).toBe(true)
    // Also survives a JSON round-trip (as reviews.json would produce).
    expect(isReview(JSON.parse(JSON.stringify(r)))).toBe(true)
  })

  test('accepts a fully-populated (claimed, completed) review', () => {
    const r: Review = {
      id: 'rev-2', personality: 'fact-checker', status: 'done', focus: null,
      requestedAt: '2026-07-08T10:00:00.000Z', agent: 'claude',
      startedAt: '2026-07-08T10:05:00.000Z', completedAt: '2026-07-08T10:20:00.000Z',
      verdict: 'holds up', commentCount: 4,
    }
    expect(isReview(r)).toBe(true)
  })

  test('rejects junk: wrong types, missing fields, unknown personality/status', () => {
    const base = makeReview('rev-1', 'trimmer', '2026-07-08T10:00:00.000Z')
    expect(isReview(null)).toBe(false)
    expect(isReview(42)).toBe(false)
    expect(isReview({ ...base, id: '' })).toBe(false)
    expect(isReview({ ...base, id: 42 })).toBe(false)
    expect(isReview({ ...base, personality: 'editor' })).toBe(false)
    expect(isReview({ ...base, status: 'claimed' })).toBe(false)
    expect(isReview({ ...base, focus: 42 })).toBe(false)
    expect(isReview({ ...base, requestedAt: 42 })).toBe(false)
    expect(isReview({ ...base, agent: 42 })).toBe(false)
    expect(isReview({ ...base, commentCount: '0' })).toBe(false)
    const { id: _drop, ...missingId } = base
    expect(isReview(missingId)).toBe(false)
  })
})

describe('composeBrief', () => {
  test('includes the personality\'s own brief text', () => {
    const p = PERSONALITIES['devils-advocate']
    const brief = composeBrief(p, null)
    expect(brief).toContain(p.brief)
  })

  test('states the comment/question budget when the personality asks questions', () => {
    const p = PERSONALITIES['devils-advocate']
    const brief = composeBrief(p, null)
    expect(brief).toContain(`at most ${p.maxComments} comments`)
    expect(brief).toContain(`${p.maxQuestions} question cards`)
  })

  test('uses question-less phrasing for a personality with maxQuestions 0 (trimmer)', () => {
    const p = PERSONALITIES.trimmer
    const brief = composeBrief(p, null)
    expect(brief).toContain('NO question cards')
    expect(brief).not.toContain('0 question cards') // never states a numeric zero budget
  })

  test('includes the shared pass rules', () => {
    const brief = composeBrief(PERSONALITIES.architect, null)
    expect(brief).toContain('How to run the pass:')
    expect(brief).toContain('complete_review')
  })

  test('includes the focus note only when a focus is given', () => {
    const withFocus = composeBrief(PERSONALITIES['first-reader'], 'just the opening section')
    expect(withFocus).toContain('The user scoped this pass: "just the opening section"')

    const withoutFocus = composeBrief(PERSONALITIES['first-reader'], null)
    expect(withoutFocus).not.toContain('The user scoped this pass')

    // Whitespace-only focus is treated the same as no focus.
    const blankFocus = composeBrief(PERSONALITIES['first-reader'], '   ')
    expect(blankFocus).not.toContain('The user scoped this pass')
  })
})
