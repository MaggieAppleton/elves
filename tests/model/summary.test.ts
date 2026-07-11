import { expect, test } from 'vitest'
import {
  summaryHash,
  isSummarizable,
  summaryState,
  mechanicalGist,
  cardGist,
  isCommentSummarizable,
  commentSummaryState,
  commentGist,
  type SummarizableCard,
  type SummarizableComment,
} from '../../src/model/summary'

const LONG = 'A '.repeat(120) + 'the end.'
const SHORT = 'a short point'

function card(over: Partial<SummarizableCard> = {}): SummarizableCard {
  return { kind: 'prose', noteKind: null, text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('summaryHash is stable for the same text and differs for different text', () => {
  expect(summaryHash('hello world')).toBe(summaryHash('hello world'))
  expect(summaryHash('hello world')).not.toBe(summaryHash('hello  world'))
})

test('isSummarizable: any non-empty prose/text-note card yes; empty/image/reference no', () => {
  expect(isSummarizable(card())).toBe(true)
  expect(isSummarizable(card({ kind: 'note', noteKind: 'text' }))).toBe(true)
  expect(isSummarizable(card({ text: SHORT }))).toBe(true) // short cards are summarized too now
  expect(isSummarizable(card({ text: '   ' }))).toBe(false) // empty/whitespace: nothing to summarize
  expect(isSummarizable(card({ noteKind: 'image', kind: 'note' }))).toBe(false)
  expect(isSummarizable(card({ noteKind: 'reference', kind: 'note' }))).toBe(false)
  // A figure card is never summarized — its title is its gist (see cardGist).
  expect(isSummarizable(card({ kind: 'figure', figureTitle: 'A diagram' }))).toBe(false)
})

test('summaryState: generate when text-bearing and missing a summary, at any length', () => {
  expect(summaryState(card())).toBe('generate')
  expect(summaryState(card({ text: SHORT }))).toBe('generate')
})

test('summaryState: generate when the text changed under an existing summary', () => {
  const c = card({ summary: 'old gist', summaryOfHash: summaryHash('different text') })
  expect(summaryState(c)).toBe('generate')
})

test('summaryState: ok when the summary matches the current text', () => {
  const c = card({ summary: 'a gist', summaryOfHash: summaryHash(LONG) })
  expect(summaryState(c)).toBe('ok')
})

test('summaryState: clear when a card is emptied but still carries a summary', () => {
  const c = card({ text: '   ', summary: 'stale gist', summaryOfHash: summaryHash(LONG) })
  expect(summaryState(c)).toBe('clear')
})

test('summaryState: ok when empty and no summary', () => {
  expect(summaryState(card({ text: '' }))).toBe('ok')
})

test('mechanicalGist returns short text unchanged and truncates long text', () => {
  expect(mechanicalGist(SHORT)).toBe(SHORT)
  const g = mechanicalGist('word '.repeat(60))
  expect(g.length).toBeLessThanOrEqual(121)
  expect(g.endsWith('…')).toBe(true)
})

test('mechanicalGist prefers a first-sentence cut when there is one', () => {
  const g = mechanicalGist('This is the whole opening sentence of the note. And then a lot more text follows here after it that we do not want to include at all really.')
  expect(g).toBe('This is the whole opening sentence of the note.')
})

test('cardGist uses the model summary when present, else a mechanical gist', () => {
  expect(cardGist(card({ summary: 'model gist' }))).toBe('model gist')
  expect(cardGist(card({ text: SHORT }))).toBe(SHORT)
})

test('cardGist for a figure is its title — never a summary of the description', () => {
  // The description (text) is long, but the map should read the figure's title.
  expect(cardGist(card({ kind: 'figure', figureTitle: 'Malleable software spectrum', text: LONG }))).toBe(
    'Malleable software spectrum',
  )
  // An untitled figure falls back to a mechanical gist of its description.
  expect(cardGist(card({ kind: 'figure', figureTitle: '', text: SHORT }))).toBe(SHORT)
})

// --- Comments: the same summary machinery, one level down --------------------

function comment(over: Partial<SummarizableComment> = {}): SummarizableComment {
  return { text: LONG, summary: null, summaryOfHash: null, ...over }
}

test('isCommentSummarizable: any non-empty comment yes, empty/whitespace no', () => {
  expect(isCommentSummarizable(comment())).toBe(true)
  expect(isCommentSummarizable(comment({ text: SHORT }))).toBe(true) // short comments too
  expect(isCommentSummarizable(comment({ text: '   ' }))).toBe(false)
})

test('commentSummaryState: generate when summarizable and missing/stale, at any length', () => {
  expect(commentSummaryState(comment())).toBe('generate')
  expect(commentSummaryState(comment({ text: SHORT }))).toBe('generate')
  expect(commentSummaryState(comment({ summary: 'old gist', summaryOfHash: summaryHash('different text') })))
    .toBe('generate')
})

test('commentSummaryState: ok when the summary matches the current text', () => {
  expect(commentSummaryState(comment({ summary: 'a gist', summaryOfHash: summaryHash(LONG) }))).toBe('ok')
})

test('commentSummaryState: clear when emptied but still carrying a stale summary', () => {
  const c = comment({ text: '   ', summary: 'stale gist', summaryOfHash: summaryHash(LONG) })
  expect(commentSummaryState(c)).toBe('clear')
})

test('commentSummaryState: ok when empty and no summary', () => {
  expect(commentSummaryState(comment({ text: '' }))).toBe('ok')
})

test('commentGist uses the model summary when present, else a mechanical gist of its own text', () => {
  expect(commentGist(comment({ summary: 'model gist' }))).toBe('model gist')
  expect(commentGist(comment({ text: SHORT }))).toBe(SHORT)
})
