import type {
  CanvasMergeConflict,
  CanvasMergeInput,
  DocumentRecord,
  DocumentRecords,
} from './canvasMergeTypes'

const DOCUMENT_ID = 'document:document'

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function hasDocumentRecord(records: DocumentRecords): boolean {
  return hasOwn(records, DOCUMENT_ID) && records[DOCUMENT_ID].typeName === 'document'
}

export function requiresCanvasParentGraph(input: CanvasMergeInput): boolean {
  return (['base', 'local', 'remote'] as const).some((source) => hasDocumentRecord(input[source]))
}

function parentConflict(
  recordId: string,
  reason: 'missing-parent-id' | 'non-string-parent-id' | 'missing-parent' | 'invalid-parent-type',
): CanvasMergeConflict {
  return { kind: 'invalid-shape-parent', recordId, path: ['parentId'], reason }
}

function findCycles(
  shapeIds: readonly string[],
  shapeParents: ReadonlyMap<string, string>,
): string[][] {
  const finished = new Set<string>()
  const cycles: string[][] = []

  for (const start of shapeIds) {
    if (finished.has(start)) continue
    const path: string[] = []
    const positions = new Map<string, number>()
    let current = start

    while (!finished.has(current)) {
      const position = positions.get(current)
      if (position !== undefined) {
        cycles.push(path.slice(position).sort())
        break
      }
      positions.set(current, path.length)
      path.push(current)
      const parentId = shapeParents.get(current)
      if (parentId === undefined) break
      current = parentId
    }
    for (const recordId of path) finished.add(recordId)
  }

  return cycles.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
}

export function validateCanvasParentGraph(
  records: DocumentRecords,
  required: boolean,
): CanvasMergeConflict[] {
  if (!required) return []

  const conflicts: CanvasMergeConflict[] = []
  const shapeParents = new Map<string, string>()
  const shapeIds = Object.keys(records)
    .filter((recordId) => hasOwn(records, recordId) && records[recordId].typeName === 'shape')
    .sort()

  for (const recordId of shapeIds) {
    const shape = records[recordId] as DocumentRecord
    if (!hasOwn(shape, 'parentId')) {
      conflicts.push(parentConflict(recordId, 'missing-parent-id'))
      continue
    }
    if (typeof shape.parentId !== 'string') {
      conflicts.push(parentConflict(recordId, 'non-string-parent-id'))
      continue
    }
    if (!hasOwn(records, shape.parentId)) {
      conflicts.push(parentConflict(recordId, 'missing-parent'))
      continue
    }
    const parent = records[shape.parentId]
    if (parent.typeName !== 'page' && parent.typeName !== 'shape') {
      conflicts.push(parentConflict(recordId, 'invalid-parent-type'))
      continue
    }
    if (parent.typeName === 'shape') shapeParents.set(recordId, shape.parentId)
  }

  for (const cycleIds of findCycles(shapeIds, shapeParents)) {
    conflicts.push({
      kind: 'shape-parent-cycle', recordId: cycleIds[0], path: ['parentId'], cycleIds,
    })
  }
  return conflicts
}
