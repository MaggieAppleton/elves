import { expect, test } from 'vitest'
import {
  addCommentsUp, addAssetIdUp, addReferenceUp, addSummaryUp,
  renameSourceToNoteUp, renameSourceToNoteDown, addAuthoredByUp, addDraftExcludedUp, addFigureUp,
} from '../../src/shapes/CardShapeUtil'

test('migration adds comments[] and mergedInto to a pre-Phase-2 card', () => {
  const oldProps: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'hi',
  }
  addCommentsUp(oldProps)
  expect(oldProps.comments).toEqual([])
  expect(oldProps.mergedInto).toBeNull()
})

test('AddAssetId migration adds assetId to a pre-image card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null,
  }
  addAssetIdUp(props)
  expect(props.assetId).toBeNull()
})

test('AddReference migration adds reference to a pre-reference card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null, assetId: null,
  }
  addReferenceUp(props)
  expect(props.reference).toBeNull()
})

test('AddSummary migration adds the four null summary fields to a pre-summary card', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', sourceKind: null, origin: null, text: 'x',
    comments: [], mergedInto: null, assetId: null, reference: null,
  }
  addSummaryUp(props)
  expect(props).toMatchObject({
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  })
})

test('RenameSourceToNote migration renames kind and the sourceKind prop', () => {
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'source', sourceKind: 'text', origin: 'typed', text: 'x',
  }
  renameSourceToNoteUp(props)
  expect(props.kind).toBe('note')
  expect(props.noteKind).toBe('text')
  expect('sourceKind' in props).toBe(false)
})

test('RenameSourceToNote leaves prose cards alone and carries a null sub-kind across', () => {
  const props: Record<string, unknown> = { kind: 'prose', sourceKind: null }
  renameSourceToNoteUp(props)
  expect(props.kind).toBe('prose')
  expect(props.noteKind).toBeNull()
  expect('sourceKind' in props).toBe(false)
})

test('RenameSourceToNote up() is idempotent on already-renamed props', () => {
  const props: Record<string, unknown> = { kind: 'note', noteKind: 'reference' }
  renameSourceToNoteUp(props)
  expect(props).toEqual({ kind: 'note', noteKind: 'reference' })
})

test('RenameSourceToNote down() restores the pre-rename shape', () => {
  const props: Record<string, unknown> = { kind: 'note', noteKind: 'image' }
  renameSourceToNoteDown(props)
  expect(props.kind).toBe('source')
  expect(props.sourceKind).toBe('image')
  expect('noteKind' in props).toBe(false)
})

test('AddAuthoredBy migration defaults an existing card to no agent author', () => {
  // Cards predate the field; we cannot know which past cards an agent made, so
  // they default to null (human-authored) and show no mark.
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null, assetId: null, reference: null,
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
  addAuthoredByUp(props)
  expect(props.authoredBy).toBeNull()
})

test('AddDraftExcluded migration defaults an existing card into the draft (not excluded)', () => {
  // The flag postdates every existing card; a card is part of the linear draft
  // unless the user opts it out, so old canvases must default to false.
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'prose', noteKind: null, origin: null, text: 'x',
    comments: [], mergedInto: null, assetId: null, reference: null,
    summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null, authoredBy: null,
  }
  addDraftExcludedUp(props)
  expect(props.draftExcluded).toBe(false)
})

test('AddFigure migration defaults an existing card to the non-figure shape', () => {
  // Existing cards are notes or prose, never figures — default them to an empty
  // title and no status so they load unchanged and show no figure chrome.
  const props: Record<string, unknown> = {
    w: 240, h: 120, kind: 'note', noteKind: 'text', origin: 'typed', text: 'x',
    comments: [], mergedInto: null, assetId: null, reference: null, authoredBy: null,
    draftExcluded: false, summary: null, summaryOfHash: null, summaryBy: null, summaryAt: null,
  }
  addFigureUp(props)
  expect(props.figureTitle).toBe('')
  expect(props.figureStatus).toBeNull()
})
