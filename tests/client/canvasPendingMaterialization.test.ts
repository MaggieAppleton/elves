import { expect, test } from 'vitest'
import type { PendingChangeSetV2 } from '../../src/client/persistence'
import {
  pendingMaterializationStatus,
} from '../../src/client/canvasPendingMaterialization'
import { changeSetTokenStamp } from '../../src/model/changeset'
import type { DocumentRecords } from '../../src/client/canvasMerge'

const pending: PendingChangeSetV2 = {
  token: { epoch: 'epoch-a', sequence: 4 },
  changeSet: {
    id: 'create-two',
    author: 'agent',
    ops: [
      { kind: 'create_note_card', text: 'Note', x: 0, y: 0 },
      { kind: 'create_section', text: 'Section', x: 10, y: 10 },
    ],
  },
}

function record(
  id: string,
  stamp: string,
  type: 'note' | 'section',
): DocumentRecords[string] {
  return type === 'section'
    ? { id, typeName: 'shape', type: 'section', props: {}, meta: { elvesChangeSetToken: stamp } }
    : {
        id,
        typeName: 'shape',
        type: 'card',
        props: { kind: 'note', noteKind: 'text' },
        meta: { elvesChangeSetToken: stamp },
      }
}

test('recognizes only the exact stamped created-kind multiset as complete', () => {
  const stamp = changeSetTokenStamp(pending.token)
  expect(pendingMaterializationStatus({}, pending)).toBe('absent')
  expect(pendingMaterializationStatus({ note: record('note', stamp, 'note') }, pending))
    .toBe('incomplete')
  expect(pendingMaterializationStatus({
    note: record('note', stamp, 'note'),
    extra: record('extra', stamp, 'note'),
  }, pending)).toBe('incomplete')
  expect(pendingMaterializationStatus({
    note: record('note', stamp, 'note'),
    section: record('section', stamp, 'section'),
  }, pending)).toBe('complete')
})

test('ignores records stamped for another pending token', () => {
  const stamp = changeSetTokenStamp(pending.token)
  expect(pendingMaterializationStatus({
    note: record('note', stamp, 'note'),
    unrelated: record('unrelated', 'epoch-a:5', 'section'),
    section: record('section', stamp, 'section'),
  }, pending)).toBe('complete')
})

test('matches server classification for all five created record kinds', () => {
  const allKinds: PendingChangeSetV2 = {
    token: { epoch: 'epoch-b', sequence: 1 },
    changeSet: {
      id: 'all-kinds', author: 'agent',
      ops: [
        { kind: 'create_note_card', text: 'Note', x: 0, y: 0 },
        {
          kind: 'create_reference', x: 0, y: 0,
          reference: {
            url: 'https://example.com', refType: 'link', title: null, authors: [],
            siteName: null, year: null, venue: null, description: null,
            faviconAssetId: null, thumbnailAssetId: null, doi: null, arxivId: null,
            fetchedBy: null, fetchedAt: null,
          },
        },
        { kind: 'create_figure_card', title: 'Figure', description: 'Plan', x: 0, y: 0 },
        { kind: 'create_section', text: 'Section', x: 0, y: 0 },
        { kind: 'create_question', text: 'Question?', x: 0, y: 0 },
      ],
    },
  }
  const stamp = changeSetTokenStamp(allKinds.token)
  const meta = { elvesChangeSetToken: stamp }
  expect(pendingMaterializationStatus({
    note: {
      id: 'note', typeName: 'shape', type: 'card',
      props: { kind: 'note', noteKind: 'text' }, meta,
    },
    reference: {
      id: 'reference', typeName: 'shape', type: 'card',
      props: { kind: 'note', noteKind: 'reference' }, meta,
    },
    figure: {
      id: 'figure', typeName: 'shape', type: 'card', props: { kind: 'figure' }, meta,
    },
    section: { id: 'section', typeName: 'shape', type: 'section', props: {}, meta },
    question: { id: 'question', typeName: 'shape', type: 'question', props: {}, meta },
  }, allKinds)).toBe('complete')
})

test('rejects a wrong created-kind multiset even when stamp count matches', () => {
  const stamp = changeSetTokenStamp(pending.token)
  expect(pendingMaterializationStatus({
    first: record('first', stamp, 'note'),
    second: record('second', stamp, 'note'),
  }, pending)).toBe('incomplete')
})

test('rejects array-valued props and meta like the server plain-object guard', () => {
  const single: PendingChangeSetV2 = {
    token: { epoch: 'epoch-c', sequence: 1 },
    changeSet: {
      id: 'single', author: 'agent',
      ops: [{ kind: 'create_note_card', text: 'Note', x: 0, y: 0 }],
    },
  }
  const stamp = changeSetTokenStamp(single.token)
  const arrayProps = Object.assign([], { kind: 'note', noteKind: 'text' })
  const arrayMeta = Object.assign([], { elvesChangeSetToken: stamp })
  expect(pendingMaterializationStatus({
    note: {
      id: 'note', typeName: 'shape', type: 'card', props: arrayProps,
      meta: { elvesChangeSetToken: stamp },
    },
  }, single)).toBe('incomplete')
  expect(pendingMaterializationStatus({
    note: {
      id: 'note', typeName: 'shape', type: 'card',
      props: { kind: 'note', noteKind: 'text' }, meta: arrayMeta,
    },
  }, single)).toBe('absent')
})
