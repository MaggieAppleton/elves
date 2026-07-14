import type { PendingChangeSetV2 } from './persistence'
import type { DocumentRecord, DocumentRecords } from './canvasMerge'
import {
  CHANGE_SET_STAMP_META_KEY,
  changeSetTokenStamp,
  type Op,
} from '../model/changeset'

type CreatedRecordKind = Extract<Op, { kind: `create_${string}` }>['kind']
export type PendingMaterializationStatus = 'absent' | 'complete' | 'incomplete'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectedKinds(entry: PendingChangeSetV2): CreatedRecordKind[] | null {
  const kinds: CreatedRecordKind[] = []
  for (const op of entry.changeSet.ops) {
    switch (op.kind) {
      case 'create_note_card':
      case 'create_reference':
      case 'create_figure_card':
      case 'create_section':
      case 'create_question':
        kinds.push(op.kind)
        break
      default:
        return null
    }
  }
  return kinds.length > 0 ? kinds : null
}

function createdKind(record: DocumentRecord): CreatedRecordKind | null {
  const props = record.props
  if (record.typeName !== 'shape' || !isRecord(props)) return null
  if (record.type === 'section') return 'create_section'
  if (record.type === 'question') return 'create_question'
  if (record.type !== 'card') return null
  if (props.kind === 'figure') return 'create_figure_card'
  if (props.kind !== 'note') return null
  if (props.noteKind === 'reference') return 'create_reference'
  return props.noteKind === 'text' ? 'create_note_card' : null
}

export function pendingMaterializationStatus(
  document: DocumentRecords,
  entry: PendingChangeSetV2,
): PendingMaterializationStatus {
  const stamp = changeSetTokenStamp(entry.token)
  const stamped = Object.values(document).filter((record) => {
    const meta = record.meta
    return isRecord(meta) && meta[CHANGE_SET_STAMP_META_KEY] === stamp
  })
  if (stamped.length === 0) return 'absent'

  const expected = expectedKinds(entry)
  if (!expected) return 'incomplete'
  const actual: CreatedRecordKind[] = []
  for (const record of stamped) {
    const kind = createdKind(record)
    if (!kind) return 'incomplete'
    actual.push(kind)
  }
  if (actual.length !== expected.length) return 'incomplete'
  actual.sort()
  expected.sort()
  return actual.every((kind, index) => kind === expected[index]) ? 'complete' : 'incomplete'
}
