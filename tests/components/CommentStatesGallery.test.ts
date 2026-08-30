import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, create } from 'react-test-renderer'
import { expect, test } from 'vitest'
import {
  COMMENT_STATE_FIXTURES,
  CommentStatesGallery,
  isCommentStatesRoute,
} from '../../src/components/CommentStatesGallery'
import { AnnotationThread } from '../../src/components/AnnotationThread'

test('recognises only the isolated comment states route', () => {
  expect(isCommentStatesRoute('/comment-states')).toBe(true)
  expect(isCommentStatesRoute('/comment-states/')).toBe(true)
  expect(isCommentStatesRoute('/')).toBe(false)
  expect(isCommentStatesRoute('/projects/essay')).toBe(false)
})

test('fixtures expose every annotation type plus freeform feedback', () => {
  expect(new Set(COMMENT_STATE_FIXTURES.map((fixture) => fixture.comment.type))).toEqual(new Set([
    'needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure',
    'counterpoint', 'tighten', 'unclear', 'structure', null,
  ]))
})

test('anchored pin catalogue names every annotation type without hover', () => {
  const tree = create(createElement(CommentStatesGallery))
  const labels = tree.root.findAllByProps({ 'data-testid': 'comment-states-pin-label' })

  expect(labels.map((label) => label.children.join(''))).toEqual([
    'Needs evidence', 'Weak argument', 'Needs citation', 'Wants figure',
    'Counterpoint', 'Tighten', 'Unclear', 'Structure', 'Comment',
  ])
})

test('a resolved gallery thread can be recovered without persistence', () => {
  const tree = create(createElement(CommentStatesGallery))
  const resolve = tree.root.findAllByProps({ className: 'elves-annotation-thread__resolve' })[0]

  act(() => resolve.props.onClick())
  expect(tree.root.findAllByProps({ 'data-testid': 'comment-states-resolved-item' })).toHaveLength(1)

  act(() => tree.root.findByProps({ 'data-testid': 'comment-states-restore' }).props.onClick())
  expect(tree.root.findAllByProps({ 'data-testid': 'comment-states-resolved-item' })).toHaveLength(0)
})

test('gallery exposes streaming, retry and reply-locked examples without an API', () => {
  const tree = create(createElement(CommentStatesGallery))

  expect(tree.root.findAllByProps({ 'data-state': 'streaming' })).toHaveLength(1)
  expect(tree.root.findAllByProps({ 'data-state': 'failed' })).toHaveLength(1)
  expect(tree.root.findAllByProps({ 'data-state': 'locked' })).toHaveLength(1)
  expect(tree.root.findAllByType(AnnotationThread).length).toBeGreaterThan(0)
  const reply = tree.root.findAllByProps({ className: 'elves-annotation-thread__reply-trigger' })[0]
  expect(reply).toBeTruthy()
  act(() => reply.props.onClick())
  expect(tree.root.findAllByType('textarea')).toHaveLength(1)

  const retry = tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))
  expect(retry).toBeTruthy()
  act(() => retry!.props.onClick())
  expect(tree.root.findAllByProps({ 'data-state': 'streaming' })).toHaveLength(2)
})

test('entry point selects the gallery before mounting App', () => {
  const source = readFileSync(resolve('src/main.tsx'), 'utf8')

  expect(source).toContain('isCommentStatesRoute(window.location.pathname)')
  expect(source).toContain('<CommentStatesGallery />')
})

test('entry point includes Agentation alongside either development root', () => {
  const source = readFileSync(resolve('src/main.tsx'), 'utf8')

  expect(source).toContain('const screen = isCommentStatesRoute(window.location.pathname) ? <CommentStatesGallery /> : <App />')
  expect(source).toContain('{import.meta.env.DEV && <Agentation endpoint="http://localhost:4747" />}')
})
