import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthorMarks } from '../../src/shapes/AuthorMarks'
import type { Attribution } from '../../src/model/types'

/** Count the author-mark spans in rendered markup by their data-testid. */
function markCount(html: string): number {
  return (html.match(/data-testid="card-agent-mark"/g) ?? []).length
}

describe('AuthorMarks — stacked contributors', () => {
  test('a card with two distinct authors renders two marks', () => {
    const attribution: Attribution = [
      { author: 'user', length: 5 },
      { author: 'claude', length: 4 },
    ]
    const html = renderToStaticMarkup(createElement(AuthorMarks, { attribution }))
    expect(markCount(html)).toBe(2)
    // Each contributor is tagged with its author id for the later highlight layer.
    expect(html).toContain('data-author="user"')
    expect(html).toContain('data-author="claude"')
  })

  test('a single-author card renders one mark', () => {
    const attribution: Attribution = [{ author: 'claude', length: 3 }]
    const html = renderToStaticMarkup(createElement(AuthorMarks, { attribution }))
    expect(markCount(html)).toBe(1)
    expect(html).toContain('data-author="claude"')
  })

  test('repeated authors collapse to one mark each, in first-appearance order', () => {
    const attribution: Attribution = [
      { author: 'claude', length: 2 },
      { author: 'user', length: 2 },
      { author: 'claude', length: 2 },
    ]
    const html = renderToStaticMarkup(createElement(AuthorMarks, { attribution }))
    expect(markCount(html)).toBe(2)
    expect(html.indexOf('data-author="claude"')).toBeLessThan(html.indexOf('data-author="user"'))
  })

  test('an unknown author id renders no mark (degrades quietly)', () => {
    const attribution: Attribution = [{ author: 'nobody-registered', length: 4 }]
    const html = renderToStaticMarkup(createElement(AuthorMarks, { attribution }))
    expect(html).toBe('')
  })

  test('null / empty attribution renders nothing', () => {
    expect(renderToStaticMarkup(createElement(AuthorMarks, { attribution: null }))).toBe('')
    expect(renderToStaticMarkup(createElement(AuthorMarks, { attribution: [] }))).toBe('')
  })
})
