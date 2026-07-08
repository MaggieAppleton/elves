import { describe, expect, test } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlameText, hasAgentRun } from '../../src/shapes/BlameText'
import type { Attribution } from '../../src/model/types'

/** Strip tags to recover the visible text, verifying nothing is dropped. */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

describe('BlameText — run-split body with per-author spans', () => {
  test('agent runs get a tinted span; human runs stay plain text', () => {
    const attribution: Attribution = [
      { author: 'user', length: 4 }, // "The "
      { author: 'claude', length: 3 }, // "cat"
      { author: 'user', length: 4 }, // " sat"
    ]
    const html = renderToStaticMarkup(
      createElement(BlameText, { text: 'The cat sat', attribution }),
    )
    // The agent's stretch is wrapped and tagged; the human's is not.
    expect(html).toContain('data-blame-author="claude"')
    expect(html).toContain('class="elves-blame-run"')
    expect(html).toContain('--blame-accent')
    expect((html.match(/elves-blame-run/g) ?? []).length).toBe(1)
    // Only the agent slice is inside a span.
    expect(html).toMatch(/<span[^>]*>cat<\/span>/)
    // No characters lost: the full text still reads back in order.
    expect(visibleText(html)).toBe('The cat sat')
  })

  test('an all-human card renders plain text with no blame spans', () => {
    const attribution: Attribution = [{ author: 'user', length: 5 }]
    const html = renderToStaticMarkup(
      createElement(BlameText, { text: 'hello', attribution }),
    )
    expect(html).not.toContain('elves-blame-run')
    expect(visibleText(html)).toBe('hello')
  })

  test('a null/corrupt attribution degrades to plain text (no characters dropped)', () => {
    const html = renderToStaticMarkup(
      createElement(BlameText, { text: 'unattributed', attribution: null }),
    )
    expect(html).not.toContain('elves-blame-run')
    expect(visibleText(html)).toBe('unattributed')
  })

  test('an unknown agent id is not tinted (degrades quietly, keeps text)', () => {
    const attribution: Attribution = [{ author: 'nobody-registered', length: 4 }]
    const html = renderToStaticMarkup(
      createElement(BlameText, { text: 'anon', attribution }),
    )
    expect(html).not.toContain('elves-blame-run')
    expect(visibleText(html)).toBe('anon')
  })

  test('whitespace and newlines inside a run are preserved', () => {
    const attribution: Attribution = [{ author: 'claude', length: 7 }]
    const html = renderToStaticMarkup(
      createElement(BlameText, { text: 'a\n  b c', attribution }),
    )
    expect(visibleText(html)).toBe('a\n  b c')
  })
})

describe('hasAgentRun — gates the hover affordance', () => {
  test('true when a resolvable agent wrote part of the text', () => {
    expect(
      hasAgentRun([
        { author: 'user', length: 2 },
        { author: 'claude', length: 2 },
      ]),
    ).toBe(true)
  })

  test('false for an all-human card', () => {
    expect(hasAgentRun([{ author: 'user', length: 5 }])).toBe(false)
  })

  test('false when the only non-human author is unregistered (nothing to reveal)', () => {
    expect(hasAgentRun([{ author: 'nobody-registered', length: 3 }])).toBe(false)
  })

  test('false for null / empty attribution', () => {
    expect(hasAgentRun(null)).toBe(false)
    expect(hasAgentRun([])).toBe(false)
  })
})
