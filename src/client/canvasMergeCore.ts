import {
  atomicFieldGroupsAt,
  canvasMergeDomainContext,
  type CanvasMergeDomainContext,
} from './canvasMergeDomain'
import type {
  CanvasMergeConflict,
  CanvasMergeInput,
  CanvasMergeResult,
  DocumentRecord,
  DocumentRecords,
  DocumentRecordType,
} from './canvasMergeTypes'

const DOCUMENT_TYPES = new Set<DocumentRecordType>([
  'asset', 'binding', 'document', 'page', 'shape',
])
const MISSING = Symbol('missing')
type Missing = typeof MISSING
type Slot = unknown | Missing

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function structuralEqual(left: Slot, right: Slot): boolean {
  if (left === MISSING || right === MISSING) return left === right
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => structuralEqual(value, right[index]))
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && structuralEqual(left[key], right[key]))
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T
  if (!isPlainObject(value)) return value
  const cloned: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) setOwn(cloned, key, cloneValue(value[key]))
  return cloned as T
}

function slot(object: Record<string, unknown>, key: string): Slot {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : MISSING
}

function selectFields(
  object: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const selected: Record<string, unknown> = {}
  if (!object) return selected
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) setOwn(selected, key, object[key])
  }
  return selected
}

function mergeObject(
  base: Record<string, unknown> | undefined,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  recordId: string,
  path: string[],
  conflicts: CanvasMergeConflict[],
  domain: CanvasMergeDomainContext,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  const keys = [...new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])].sort()
  const values = new Map<string, Slot>()
  const groupedKeys = new Set<string>()
  for (const group of atomicFieldGroupsAt(domain, path)) {
    group.keys.forEach((key) => groupedKeys.add(key))
    const baseFields = selectFields(base, group.keys)
    const localFields = selectFields(local, group.keys)
    const remoteFields = selectFields(remote, group.keys)
    let selected: Record<string, unknown> | null = null
    if (structuralEqual(localFields, remoteFields)) selected = localFields
    else if (structuralEqual(localFields, baseFields)) selected = remoteFields
    else if (structuralEqual(remoteFields, baseFields)) selected = localFields
    else conflicts.push({ kind: 'atomic-field-conflict', recordId, path: group.conflictPath })
    if (selected) {
      for (const key of group.keys) {
        if (Object.prototype.hasOwnProperty.call(selected, key)) {
          values.set(key, cloneValue(selected[key]))
        }
      }
    }
  }
  for (const key of keys) {
    if (groupedKeys.has(key)) continue
    const value = mergeSlot(
      base ? slot(base, key) : MISSING,
      slot(local, key),
      slot(remote, key),
      recordId,
      [...path, key],
      conflicts,
      domain,
    )
    values.set(key, value)
  }
  for (const key of keys) {
    const value = values.has(key) ? values.get(key)! : MISSING
    if (value !== MISSING) setOwn(merged, key, value)
  }
  return merged
}

function mergeSlot(
  base: Slot,
  local: Slot,
  remote: Slot,
  recordId: string,
  path: string[],
  conflicts: CanvasMergeConflict[],
  domain: CanvasMergeDomainContext,
): Slot {
  if (structuralEqual(local, remote)) return local === MISSING ? MISSING : cloneValue(local)
  if (structuralEqual(local, base)) return remote === MISSING ? MISSING : cloneValue(remote)
  if (structuralEqual(remote, base)) return local === MISSING ? MISSING : cloneValue(local)

  if (local !== MISSING && remote !== MISSING && isPlainObject(local) && isPlainObject(remote) &&
    (base === MISSING || isPlainObject(base))) {
    return mergeObject(
      base === MISSING ? undefined : base,
      local,
      remote,
      recordId,
      path,
      conflicts,
      domain,
    )
  }

  conflicts.push({ kind: 'field-value-conflict', recordId, path })
  return MISSING
}

function validateBoundary(input: CanvasMergeInput): CanvasMergeConflict[] {
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
          kind: 'invalid-document-record', source, recordId, path: ['typeName'], reason: 'non-document-type',
        })
      }
    }
  }
  return conflicts
}

export function mergeCanvasRecords(input: CanvasMergeInput): CanvasMergeResult {
  const boundaryConflicts = validateBoundary(input)
  if (boundaryConflicts.length > 0) return { ok: false, conflicts: boundaryConflicts }

  const document: DocumentRecords = {}
  const conflicts: CanvasMergeConflict[] = []
  const recordIds = [...new Set([
    ...Object.keys(input.base),
    ...Object.keys(input.local),
    ...Object.keys(input.remote),
  ])].sort()

  for (const recordId of recordIds) {
    const base = slot(input.base, recordId)
    const local = slot(input.local, recordId)
    const remote = slot(input.remote, recordId)

    if (base === MISSING) {
      if (local === MISSING && remote === MISSING) continue
      if (local === MISSING || remote === MISSING) {
        setOwn(document, recordId, cloneValue((local === MISSING ? remote : local) as DocumentRecord))
      } else if (structuralEqual(local, remote)) {
        setOwn(document, recordId, cloneValue(local as DocumentRecord))
      } else {
        conflicts.push({ kind: 'record-addition-conflict', recordId, path: [] })
      }
      continue
    }

    if (local === MISSING && remote === MISSING) continue
    if (local === MISSING || remote === MISSING) {
      const retained = local === MISSING ? remote : local
      if (!structuralEqual(retained, base)) {
        conflicts.push({ kind: 'record-delete-edit-conflict', recordId, path: [] })
      }
      continue
    }

    const domain = canvasMergeDomainContext(
      base as Record<string, unknown>,
      local as Record<string, unknown>,
      remote as Record<string, unknown>,
    )
    const merged = mergeSlot(base, local, remote, recordId, [], conflicts, domain)
    if (merged !== MISSING) setOwn(document, recordId, merged as DocumentRecord)
  }

  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, document }
}
