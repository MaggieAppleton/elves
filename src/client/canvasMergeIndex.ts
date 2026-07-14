import { generateNKeysBetween } from 'fractional-indexing-jittered'
import type {
  CanvasMergeInput,
  DocumentRecord,
  DocumentRecords,
} from './canvasMergeTypes'

interface IndexedShape {
  id: string
  index: string
  record: DocumentRecord
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function setIndex(record: DocumentRecord, index: string): void {
  Object.defineProperty(record, 'index', {
    value: index,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function provenanceRank(recordId: string, input: CanvasMergeInput): number {
  if (hasOwn(input.remote, recordId)) return 0
  if (hasOwn(input.local, recordId)) return 1
  return 2
}

function siblingGroups(document: DocumentRecords): Map<string, IndexedShape[]> {
  const groups = new Map<string, IndexedShape[]>()
  for (const recordId of Object.keys(document).sort()) {
    const record = hasOwn(document, recordId) ? document[recordId] : undefined
    if (record?.typeName !== 'shape' || !hasOwn(record, 'parentId') ||
      typeof record.parentId !== 'string' || !hasOwn(record, 'index') ||
      typeof record.index !== 'string') continue
    const siblings = groups.get(record.parentId) ?? []
    siblings.push({ id: recordId, index: record.index, record })
    groups.set(record.parentId, siblings)
  }
  return groups
}

function indexRuns(siblings: IndexedShape[]): IndexedShape[][] {
  siblings.sort((left, right) => compareText(left.index, right.index) || compareText(left.id, right.id))
  const runs: IndexedShape[][] = []
  for (const sibling of siblings) {
    const last = runs[runs.length - 1]
    if (last?.[0].index === sibling.index) last.push(sibling)
    else runs.push([sibling])
  }
  return runs
}

function repairSiblingGroup(siblings: IndexedShape[], input: CanvasMergeInput): void {
  const runs = indexRuns(siblings)
  let lower: string | null = null
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]
    if (run.length === 1) {
      lower = run[0].index
      continue
    }

    const upper = runs[index + 1]?.[0].index ?? null
    const ordered = [...run].sort((left, right) =>
      provenanceRank(left.id, input) - provenanceRank(right.id, input) ||
      compareText(left.id, right.id))
    const generated = generateNKeysBetween(lower, upper, ordered.length)
    ordered.forEach((sibling, position) => setIndex(sibling.record, generated[position]))
    lower = generated[generated.length - 1]
  }
}

export function repairCanvasSiblingIndices(
  document: DocumentRecords,
  input: CanvasMergeInput,
  required: boolean,
): void {
  if (!required) return
  const groups = siblingGroups(document)
  for (const parentId of [...groups.keys()].sort()) {
    repairSiblingGroup(groups.get(parentId)!, input)
  }
}
