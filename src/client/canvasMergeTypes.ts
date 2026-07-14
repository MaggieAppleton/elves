export type DocumentRecordType = 'asset' | 'binding' | 'document' | 'page' | 'shape'

export interface DocumentRecord {
  id: string
  typeName: DocumentRecordType
  [key: string]: unknown
}

export type DocumentRecords = Record<string, DocumentRecord>
export type CanvasMergeSource = 'base' | 'local' | 'remote'

export type CanvasMergeConflict =
  | {
      kind: 'record-addition-conflict'
      recordId: string
      path: string[]
    }
  | {
      kind: 'record-delete-edit-conflict'
      recordId: string
      path: string[]
    }
  | {
      kind: 'field-value-conflict'
      recordId: string
      path: string[]
    }
  | {
      kind: 'atomic-field-conflict'
      recordId: string
      path: string[]
    }
  | {
      kind: 'comment-addition-conflict' | 'comment-delete-edit-conflict'
      recordId: string
      path: string[]
    }
  | {
      kind: 'invalid-comment'
      source: CanvasMergeSource
      recordId: string
      path: string[]
      reason: 'duplicate-id' | 'missing-id' | 'non-string-id' |
        'missing-text' | 'non-string-text' | 'invalid-list'
    }
  | {
      kind: 'invalid-document-record'
      source: CanvasMergeSource
      recordId: string
      path: string[]
      reason: 'invalid-record' | 'non-document-type' | 'key-id-mismatch'
    }
  | {
      kind: 'invalid-shape-parent'
      recordId: string
      path: string[]
      reason: 'missing-parent-id' | 'non-string-parent-id' |
        'missing-parent' | 'invalid-parent-type'
    }
  | {
      kind: 'shape-parent-cycle'
      recordId: string
      path: string[]
      cycleIds: string[]
    }
  | {
      kind: 'shape-structure-overlap'
      recordId: string
      path: string[]
      shapeIds: string[]
    }

export type CanvasMergeResult =
  | { ok: true; document: DocumentRecords }
  | { ok: false; conflicts: CanvasMergeConflict[] }

export interface CanvasMergeInput {
  base: DocumentRecords
  local: DocumentRecords
  remote: DocumentRecords
}
