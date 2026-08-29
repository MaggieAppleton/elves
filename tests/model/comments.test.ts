import { describe, expect, test } from 'vitest'
import {
  makeComment,
  addComment,
  resolveComment,
  visibleComments,
  estimateCommentHeight,
  appendThreadMessage,
  commentThread,
} from '../../src/model/comments'

describe('comment helpers', () => {
  test('makeComment defaults to freeform, unresolved, claude-authored, no review, and unsummarized', () => {
    expect(makeComment('c1', 'thin here')).toEqual({
      id: 'c1', type: null, text: 'thin here', resolved: false, author: 'claude',
      reviewId: null,
      summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
    })
    expect(makeComment('c2', 'no source', 'needs-evidence').type).toBe('needs-evidence')
  })

  test('makeComment stamps the authoring agent id when given one', () => {
    expect(makeComment('c1', 'thin here', null, 'codex').author).toBe('codex')
    // Default stays 'claude' so existing callers/canvases are unaffected.
    expect(makeComment('c2', 'thin here').author).toBe('claude')
  })

  test('makeComment stamps the reviewId when given one, defaulting to null', () => {
    expect(makeComment('c1', 'no evidence', 'needs-evidence', 'claude', 'rev-1').reviewId).toBe('rev-1')
    expect(makeComment('c2', 'thin here').reviewId).toBeNull()
  })

  test('addComment appends immutably', () => {
    const a = makeComment('c1', 'a')
    const out = addComment([], a)
    expect(out).toEqual([a])
  })

  test('legacy comments become a single Claude message', () => {
    expect(commentThread(makeComment('c1', 'Needs evidence'))).toMatchObject({
      messages: [{ author: 'claude', text: 'Needs evidence' }],
    })
  })

  test('appending a reply preserves message order and de-duplicates its id', () => {
    const comment = makeComment('c1', 'Needs evidence')
    const reply = { id: 'm-user', author: 'user', text: 'Which source?', createdAt: '2026-08-29T12:00:00.000Z' }
    const once = appendThreadMessage(comment, reply)
    const twice = appendThreadMessage(once, reply)
    expect(commentThread(twice).messages.map((message) => message.author)).toEqual(['claude', 'user'])
  })

  test('resolveComment marks one resolved without touching others', () => {
    const a = makeComment('c1', 'a')
    const b = makeComment('c2', 'b')
    const out = resolveComment([a, b], 'c1')
    expect(out.find((c) => c.id === 'c1')!.resolved).toBe(true)
    expect(out.find((c) => c.id === 'c2')!.resolved).toBe(false)
  })

  test('visibleComments hides resolved ones', () => {
    const a = { ...makeComment('c1', 'a'), resolved: true }
    const b = makeComment('c2', 'b')
    expect(visibleComments([a, b])).toEqual([b])
  })

  test('estimateCommentHeight ignores resolved comments', () => {
    expect(estimateCommentHeight([
      { ...makeComment('c1', 'gone'), resolved: true },
    ], 370)).toBe(0)
  })

  test('estimateCommentHeight reserves text, type-label, stack gap, and top gutter', () => {
    expect(estimateCommentHeight([
      makeComment('c1', 'short'),
      makeComment('c2', 'typed', 'structure'),
    ], 370)).toBe(107)
  })
})
