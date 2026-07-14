import type {
  CanvasMergeConflict,
  CanvasMergeInput,
  DocumentRecord,
  DocumentRecords,
} from './canvasMergeTypes'

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function isShape(record: DocumentRecord | undefined): record is DocumentRecord {
  return record?.typeName === 'shape'
}

function isGroup(record: DocumentRecord | undefined): boolean {
  return isShape(record) && record.type === 'group'
}

function parentChanged(base: DocumentRecord, side: DocumentRecord): boolean {
  const baseHasParent = hasOwn(base, 'parentId')
  const sideHasParent = hasOwn(side, 'parentId')
  return baseHasParent !== sideHasParent ||
    (baseHasParent && !Object.is(base.parentId, side.parentId))
}

function structuralDeltaIds(base: DocumentRecords, side: DocumentRecords): string[] {
  const ids = new Set([...Object.keys(base), ...Object.keys(side)])
  const deltas: string[] = []
  for (const recordId of [...ids].sort()) {
    const baseRecord = hasOwn(base, recordId) ? base[recordId] : undefined
    const sideRecord = hasOwn(side, recordId) ? side[recordId] : undefined
    if (isShape(baseRecord) && isShape(sideRecord) && parentChanged(baseRecord, sideRecord)) {
      deltas.push(recordId)
    } else if ((!baseRecord && isGroup(sideRecord)) || (isGroup(baseRecord) && !sideRecord)) {
      deltas.push(recordId)
    }
  }
  return deltas
}

function parentMap(records: DocumentRecords): Map<string, string> {
  const parents = new Map<string, string>()
  for (const recordId of Object.keys(records).sort()) {
    const record = hasOwn(records, recordId) ? records[recordId] : undefined
    if (isShape(record) && hasOwn(record, 'parentId') && typeof record.parentId === 'string') {
      parents.set(recordId, record.parentId)
    }
  }
  return parents
}

function reachesAncestor(
  descendantId: string,
  ancestorId: string,
  parents: ReadonlyMap<string, string>,
): boolean {
  const visited = new Set<string>()
  let current = descendantId
  while (!visited.has(current)) {
    visited.add(current)
    const parentId = parents.get(current)
    if (parentId === undefined) return false
    if (parentId === ancestorId) return true
    current = parentId
  }
  return false
}

function relatedInAnyMap(
  leftId: string,
  rightId: string,
  parentMaps: readonly ReadonlyMap<string, string>[],
): boolean {
  return parentMaps.some((parents) =>
    reachesAncestor(leftId, rightId, parents) || reachesAncestor(rightId, leftId, parents))
}

function connect(adjacency: Map<string, Set<string>>, leftId: string, rightId: string): void {
  if (!adjacency.has(leftId)) adjacency.set(leftId, new Set())
  if (!adjacency.has(rightId)) adjacency.set(rightId, new Set())
  adjacency.get(leftId)!.add(rightId)
  adjacency.get(rightId)!.add(leftId)
}

function overlapComponents(adjacency: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const visited = new Set<string>()
  const components: string[][] = []
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue
    const pending = [start]
    const component: string[] = []
    visited.add(start)
    while (pending.length > 0) {
      const recordId = pending.pop()!
      component.push(recordId)
      for (const neighbor of [...(adjacency.get(recordId) ?? [])].sort()) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor)
          pending.push(neighbor)
        }
      }
    }
    components.push(component.sort())
  }
  return components
}

export function detectCanvasStructureOverlaps(
  input: CanvasMergeInput,
  required: boolean,
): CanvasMergeConflict[] {
  if (!required) return []
  const localDeltas = structuralDeltaIds(input.base, input.local)
  const remoteDeltas = structuralDeltaIds(input.base, input.remote)
  const maps = [parentMap(input.base), parentMap(input.local), parentMap(input.remote)]
  const adjacency = new Map<string, Set<string>>()

  for (const localId of localDeltas) {
    for (const remoteId of remoteDeltas) {
      if (localId !== remoteId && relatedInAnyMap(localId, remoteId, maps)) {
        connect(adjacency, localId, remoteId)
      }
    }
  }

  return overlapComponents(adjacency).map((shapeIds) => ({
    kind: 'shape-structure-overlap',
    recordId: shapeIds[0],
    path: ['structure'],
    shapeIds,
  }))
}
