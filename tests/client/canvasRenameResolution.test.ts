import { expect, test } from 'vitest'
import type { Project } from '../../src/client/persistence'
import {
  classifyCanvasRenameOutcome,
  validRenameResult,
} from '../../src/client/canvasRenameResolution'

const original: Project = {
  id: 'draft',
  name: 'Draft',
  createdAt: '2026-07-14T00:00:00.000Z',
}

function project(fields: Partial<Project> = {}): Project {
  return { ...original, ...fields }
}

test('classifies committed, rolled-back, and partial-move identities', () => {
  expect(classifyCanvasRenameOutcome(
    [project({ id: 'report-2', name: 'Report' })], original, 'Report',
  )).toEqual({
    kind: 'committed',
    project: project({ id: 'report-2', name: 'Report' }),
  })
  expect(classifyCanvasRenameOutcome([original], original, 'Report')).toEqual({
    kind: 'rolled-back', project: original,
  })
  expect(classifyCanvasRenameOutcome(
    [project({ id: 'report', name: 'Draft' })], original, 'Report',
  )).toEqual({
    kind: 'partial-move', project: project({ id: 'report', name: 'Draft' }),
  })
})

test('requires exactly one valid createdAt identity match', () => {
  expect(classifyCanvasRenameOutcome([], original, 'Report')).toMatchObject({
    kind: 'ambiguous', reason: 'identity-match-count',
  })
  expect(classifyCanvasRenameOutcome([
    original,
    project({ id: 'draft-copy' }),
  ], original, 'Report')).toMatchObject({
    kind: 'ambiguous', reason: 'identity-match-count',
  })
  expect(classifyCanvasRenameOutcome([
    { id: 'draft', name: 'Draft' },
  ], original, 'Report')).toMatchObject({
    kind: 'ambiguous', reason: 'invalid-project-list',
  })
})

test('rejects unknown identity states and malformed lists', () => {
  expect(classifyCanvasRenameOutcome(
    [project({ id: 'report', name: 'Unexpected' })], original, 'Report',
  )).toMatchObject({ kind: 'ambiguous', reason: 'unknown-state' })
  expect(classifyCanvasRenameOutcome(null, original, 'Report')).toMatchObject({
    kind: 'ambiguous', reason: 'invalid-project-list',
  })
})

test('validates a successful rename response against name and identity', () => {
  expect(validRenameResult(
    project({ id: 'report-2', name: 'Report' }), original, 'Report',
  )).toEqual(project({ id: 'report-2', name: 'Report' }))
  expect(validRenameResult(
    project({ id: 'report', name: 'Other' }), original, 'Report',
  )).toBeNull()
  expect(validRenameResult(
    project({ id: 'report', name: 'Report', createdAt: 'different' }), original, 'Report',
  )).toBeNull()
  expect(validRenameResult(
    { id: '../report', name: 'Report', createdAt: original.createdAt }, original, 'Report',
  )).toBeNull()
})
