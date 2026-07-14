import {
  isEqual,
  type RecordsDiff,
  type TLRecord,
  type TLStore,
  type TLStoreSnapshot,
} from 'tldraw'
import type { DocumentRecord, DocumentRecords } from './canvasMerge'

export type CanvasDocumentSnapshot =
  | TLStoreSnapshot
  | { document?: TLStoreSnapshot | null }

const DOCUMENT_TYPES = new Set(['asset', 'binding', 'document', 'page', 'shape'])

function asDocumentRecords(records: Record<string, TLRecord>): DocumentRecords {
  const document: DocumentRecords = {}
  for (const id of Object.keys(records).sort()) {
    const record = records[id]
    if (DOCUMENT_TYPES.has(record.typeName)) {
      document[id] = structuredClone(record) as unknown as DocumentRecord
    }
  }
  return document
}

/** Capture only persisted tldraw document state, never camera or session state. */
export function captureCanvasDocument(store: TLStore): DocumentRecords {
  return asDocumentRecords(store.getStoreSnapshot().store)
}

/** Migrate a fetched document with the exact schema owned by the mounted store. */
export function normalizeCanvasDocument(
  store: TLStore,
  snapshot: CanvasDocumentSnapshot,
): DocumentRecords {
  const document = 'store' in snapshot ? snapshot : snapshot.document
  if (!document) return {}
  return asDocumentRecords(store.migrateSnapshot(document).store)
}

export function diffCanvasDocuments(
  before: DocumentRecords,
  after: DocumentRecords,
): RecordsDiff<TLRecord> {
  const added: Record<string, TLRecord> = {}
  const updated: Record<string, [TLRecord, TLRecord]> = {}
  const removed: Record<string, TLRecord> = {}

  for (const id of Object.keys(after).sort()) {
    const next = after[id]
    const previous = before[id]
    if (!previous) {
      added[id] = next as unknown as TLRecord
    } else if (!isEqual(previous, next)) {
      updated[id] = [previous as unknown as TLRecord, next as unknown as TLRecord]
    }
  }

  for (const id of Object.keys(before).sort()) {
    if (!(id in after)) removed[id] = before[id] as unknown as TLRecord
  }

  return {
    added: added as RecordsDiff<TLRecord>['added'],
    updated: updated as RecordsDiff<TLRecord>['updated'],
    removed: removed as RecordsDiff<TLRecord>['removed'],
  }
}

/** Apply a merged document as remote state so autosave and undo do not echo it. */
export function applyCanvasDocument(store: TLStore, next: DocumentRecords): string[] {
  const current = captureCanvasDocument(store)
  const diff = diffCanvasDocuments(current, next)
  const changedIds = [
    ...Object.keys(diff.added),
    ...Object.keys(diff.updated),
    ...Object.keys(diff.removed),
  ].sort()

  if (changedIds.length > 0) {
    store.mergeRemoteChanges(() => store.applyDiff(diff))
  }
  return changedIds
}
