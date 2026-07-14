// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import {
  createTLStore,
  defaultShapeUtils,
  Editor,
  getSnapshot,
  type TLAnyShapeUtilConstructor,
  type TLShapeId,
} from 'tldraw'
import { applyChangeSet } from '../../src/apply/applyChangeSet'
import { createTldrawCanvasWriteCoordinatorEditor } from '../../src/client/tldrawCanvasWriteCoordinatorEditor'
import type { CanvasSnapshot } from '../../src/client/persistence'
import type { ChangeSet } from '../../src/model/changeset'
import { CHANGE_SET_STAMP_META_KEY } from '../../src/model/changeset'
import { CardShapeUtil } from '../../src/shapes/CardShapeUtil'
import { QuestionShapeUtil } from '../../src/shapes/QuestionShapeUtil'
import { SectionShapeUtil } from '../../src/shapes/SectionShapeUtil'

const mounted: Array<{ editor: Editor; container: HTMLDivElement }> = []
const shapeUtils: TLAnyShapeUtilConstructor[] = [
  ...defaultShapeUtils,
  CardShapeUtil,
  SectionShapeUtil,
  QuestionShapeUtil,
]

beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
})

function makeEditor(): Editor {
  const container = document.createElement('div')
  document.body.append(container)
  const store = createTLStore({ shapeUtils })
  const editor = new Editor({
    store,
    shapeUtils,
    bindingUtils: [],
    tools: [],
    getContainer: () => container,
  })
  mounted.push({ editor, container })
  return editor
}

function createNoteChangeSet(id: string): ChangeSet {
  return {
    id,
    author: 'claude',
    ops: [{ kind: 'create_note_card', text: id, x: 10, y: 20 }],
  }
}

afterEach(() => {
  for (const { editor, container } of mounted.splice(0)) {
    editor.dispose()
    container.remove()
  }
})

afterAll(() => {
  vi.unstubAllGlobals()
})

test('loading the initial snapshot cannot be undone back to the prior canvas', () => {
  const source = makeEditor()
  const sourceIds = applyChangeSet(source, createNoteChangeSet('initial-note'))
  const snapshot = structuredClone(getSnapshot(source.store)) as unknown as CanvasSnapshot

  const target = makeEditor()
  const adapter = createTldrawCanvasWriteCoordinatorEditor(target)
  expect(target.getCanUndo()).toBe(false)

  adapter.loadInitialSnapshot(snapshot)

  expect(target.getShape(sourceIds[0] as TLShapeId)).toBeDefined()
  expect(target.getCanUndo()).toBe(false)
  target.undo()
  expect(target.getShape(sourceIds[0] as TLShapeId)).toBeDefined()
})

test('accepted materialization is not undoable while ordinary apply remains one undo step', () => {
  const acceptedEditor = makeEditor()
  const adapter = createTldrawCanvasWriteCoordinatorEditor(acceptedEditor)
  const acceptedIds = adapter.applyAcceptedChangeSet(
    createNoteChangeSet('accepted-note'),
    'epoch-a:23',
  )

  expect(acceptedIds).toHaveLength(1)
  expect(acceptedEditor.getShape(acceptedIds[0] as TLShapeId)?.meta).toEqual({
    [CHANGE_SET_STAMP_META_KEY]: 'epoch-a:23',
  })
  expect(acceptedEditor.getCanUndo()).toBe(false)
  acceptedEditor.undo()
  expect(acceptedEditor.getShape(acceptedIds[0] as TLShapeId)).toBeDefined()

  const ordinaryEditor = makeEditor()
  const ordinaryIds = applyChangeSet(ordinaryEditor, createNoteChangeSet('ordinary-note'))
  expect(ordinaryEditor.getCanUndo()).toBe(true)
  ordinaryEditor.undo()
  expect(ordinaryEditor.getShape(ordinaryIds[0] as TLShapeId)).toBeUndefined()
})
