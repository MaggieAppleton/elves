import { describe, expect, test } from 'vitest'
import type { Reference } from '../../src/model/types'
import {
  authorsLabel, guessRefType, refHost, refEyebrow, refMeta, refDescription,
  hasLeftMedia, refTitle, blankReference,
} from '../../src/model/references'

function ref(overrides: Partial<Reference>): Reference {
  return {
    url: 'https://example.com', refType: 'link', title: null, authors: [], siteName: null,
    year: null, venue: null, description: null, faviconAssetId: null, thumbnailAssetId: null,
    doi: null, arxivId: null, fetchedBy: null, fetchedAt: null, ...overrides,
  }
}

describe('authorsLabel', () => {
  test('joins up to three, then et al.', () => {
    expect(authorsLabel([])).toBe('')
    expect(authorsLabel(['Cao'])).toBe('Cao')
    expect(authorsLabel(['Cao', 'Jiang'])).toBe('Cao & Jiang')
    expect(authorsLabel(['Cao', 'Jiang', 'Xia'])).toBe('Cao, Jiang & Xia')
    expect(authorsLabel(['Cao', 'Jiang', 'Xia', 'Glassman'])).toBe('Cao et al.')
  })
  test('ignores blank names', () => {
    expect(authorsLabel(['Cao', '  '])).toBe('Cao')
  })
})

describe('guessRefType', () => {
  test('maps hosts to a kind', () => {
    expect(guessRefType('https://arxiv.org/abs/2501.01234')).toBe('paper')
    expect(guessRefType('https://doi.org/10.1145/x')).toBe('paper')
    expect(guessRefType('https://example.com/paper.pdf')).toBe('paper')
    expect(guessRefType('https://x.com/tchernavskij/status/1')).toBe('social')
    expect(guessRefType('https://bsky.app/profile/x')).toBe('social')
    expect(guessRefType('https://github.com/home-assistant/core')).toBe('software')
    expect(guessRefType('https://en.wikipedia.org/wiki/Hypertext')).toBe('wiki')
    expect(guessRefType('https://www.youtube.com/watch?v=x')).toBe('video')
    expect(guessRefType('https://andymatuschak.org/posts/glimpse')).toBe('article')
  })
})

describe('refHost', () => {
  test('strips www, tolerates junk', () => {
    expect(refHost('https://www.example.com/a/b')).toBe('example.com')
    expect(refHost('not a url')).toBe('')
  })
})

describe('type-adaptive face fields', () => {
  test('paper eyebrow/meta prefer venue + authors', () => {
    const r = ref({ refType: 'paper', venue: 'CHI 2025', year: 2025, authors: ['Cao', 'Jiang', 'Xia'] })
    expect(refEyebrow(r)).toBe('Paper · CHI 2025')
    expect(refMeta(r)).toBe('Cao, Jiang & Xia')
    expect(refDescription(r)).toBeNull()
  })
  test('social shows the handle as eyebrow and the post as description', () => {
    const r = ref({ refType: 'social', authors: ['@tchernavskij'], description: 'recombining at the site of use' })
    expect(refEyebrow(r)).toBe('@tchernavskij')
    expect(refMeta(r)).toBeNull()
    expect(refDescription(r)).toBe('recombining at the site of use')
  })
  test('article eyebrow falls back to the host', () => {
    expect(refEyebrow(ref({ refType: 'article', url: 'https://andymatuschak.org/x' }))).toBe('andymatuschak.org')
  })
  test('hasLeftMedia only for book/social with a thumbnail', () => {
    expect(hasLeftMedia(ref({ refType: 'social', thumbnailAssetId: 'a.png' }))).toBe(true)
    expect(hasLeftMedia(ref({ refType: 'book', thumbnailAssetId: 'a.png' }))).toBe(true)
    expect(hasLeftMedia(ref({ refType: 'social', thumbnailAssetId: null }))).toBe(false)
    expect(hasLeftMedia(ref({ refType: 'paper', thumbnailAssetId: 'a.png' }))).toBe(false)
  })
  test('refTitle falls back to the host then the url', () => {
    expect(refTitle(ref({ title: 'Real Title' }))).toBe('Real Title')
    expect(refTitle(ref({ title: null, url: 'https://example.com/p' }))).toBe('example.com')
  })
})

describe('blankReference', () => {
  test('fills only the url-derivable fields', () => {
    const r = blankReference('https://arxiv.org/abs/1', '2026-07-02T00:00:00.000Z')
    expect(r).toMatchObject({
      url: 'https://arxiv.org/abs/1', refType: 'paper', siteName: 'arxiv.org',
      title: null, authors: [], fetchedBy: 'unfurl', fetchedAt: '2026-07-02T00:00:00.000Z',
    })
  })
  test('honours an explicit refType and fetcher', () => {
    const r = blankReference('https://example.com', null, 'book', 'user')
    expect(r.refType).toBe('book')
    expect(r.fetchedBy).toBe('user')
  })
})
