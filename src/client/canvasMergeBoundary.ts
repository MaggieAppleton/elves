import type {
  CanvasMergeConflict,
  CanvasMergeInput,
  DocumentRecordType,
} from './canvasMergeTypes'

const DOCUMENT_TYPES = new Set<DocumentRecordType>([
  'asset', 'binding', 'document', 'page', 'shape',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function validateBoundary(input: CanvasMergeInput): CanvasMergeConflict[] {
  const conflicts: CanvasMergeConflict[] = []
  for (const source of ['base', 'local', 'remote'] as const) {
    const records = input[source] as Record<string, unknown>
    for (const recordId of Object.keys(records).sort()) {
      const record = records[recordId]
      if (!isPlainObject(record) || typeof record.id !== 'string' || typeof record.typeName !== 'string') {
        conflicts.push({
          kind: 'invalid-document-record', source, recordId, path: [], reason: 'invalid-record',
        })
        continue
      }
      if (record.id !== recordId) {
        conflicts.push({
          kind: 'invalid-document-record', source, recordId, path: ['id'], reason: 'key-id-mismatch',
        })
      }
      if (!DOCUMENT_TYPES.has(record.typeName as DocumentRecordType)) {
        conflicts.push({
          kind: 'invalid-document-record', source, recordId,
          path: ['typeName'], reason: 'non-document-type',
        })
      }
    }
  }
  return conflicts
}
