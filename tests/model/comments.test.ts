import { describe, expect, test } from 'vitest'
import { makeComment, addComment, resolveComment, visibleComments } from '../../src/model/comments'

describe('comment helpers', () => {
  test('makeComment defaults to freeform, unresolved, claude-authored', () => {
    expect(makeComment('c1', 'thin here')).toEqual({
      id: 'c1', type: null, text: 'thin here', resolved: false, author: 'claude',
    })
    expect(makeComment('c2', 'no source', 'needs-evidence').type).toBe('needs-evidence')
  })

  test('addComment appends immutably', () => {
    const a = makeComment('c1', 'a')
    const out = addComment([], a)
    expect(out).toEqual([a])
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
})
