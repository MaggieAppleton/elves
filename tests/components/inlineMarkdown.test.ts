import { describe, expect, test } from 'vitest'
import { tokenizeInlineMarkdown } from '../../src/components/inlineMarkdown'

describe('tokenizeInlineMarkdown', () => {
  test('keeps plain text as one token', () => {
    expect(tokenizeInlineMarkdown('Plain prose.')).toEqual([
      { type: 'text', value: 'Plain prose.' },
    ])
  })

  test('extracts multiple safe Markdown links without losing punctuation', () => {
    expect(
      tokenizeInlineMarkdown(
        'Read [one](https://one.test), then [two](mailto:two@test.dev).',
      ),
    ).toEqual([
      { type: 'text', value: 'Read ' },
      { type: 'link', label: 'one', href: 'https://one.test' },
      { type: 'text', value: ', then ' },
      { type: 'link', label: 'two', href: 'mailto:two@test.dev' },
      { type: 'text', value: '.' },
    ])
  })

  test.each([
    '[broken](not a url)',
    '[unsafe](javascript:alert(1))',
    '[unfinished](https://example.com',
  ])('leaves malformed or unsafe Markdown literal: %s', (source) => {
    expect(tokenizeInlineMarkdown(source)).toEqual([{ type: 'text', value: source }])
  })
})
