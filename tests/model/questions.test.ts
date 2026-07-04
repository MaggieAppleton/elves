import { describe, expect, test } from 'vitest'
import { makeQuestionProps, QUESTION_DEFAULT_W, QUESTION_DEFAULT_H } from '../../src/model/questions'

describe('question factory', () => {
  test('defaults to an empty, claude-authored, undismissed question', () => {
    expect(makeQuestionProps()).toEqual({
      w: QUESTION_DEFAULT_W, h: QUESTION_DEFAULT_H, text: '', authoredBy: 'claude', dismissed: false,
    })
  })

  test('text and author can be set; another agent can ask', () => {
    const p = makeQuestionProps('Why should a debugger novice care?', 'openai')
    expect(p.text).toBe('Why should a debugger novice care?')
    expect(p.authoredBy).toBe('openai')
    expect(p.dismissed).toBe(false)
  })
})
