import {
  atomicFieldGroupsAt,
  canvasMergeDomainContext,
  type CanvasMergeDomainContext,
} from './canvasMergeDomain'
import {
  estimateMergedCommentHeight,
  finalizeAddedCardRecord,
  mergeCardComments,
} from './canvasMergeComments'
import { validateBoundary } from './canvasMergeBoundary'
import { finalizeRecordSummaries } from './canvasMergeSummaries'
import type {
  CanvasMergeConflict,
  CanvasMergeInput,
  CanvasMergeResult,
  DocumentRecord,
  DocumentRecords,
} from './canvasMergeTypes'

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

function setDocumentRecord(
  document: DocumentRecords,
  recordId: string,
  record: DocumentRecord,
): void {
  setOwn(document, recordId, finalizeRecordSummaries(record))
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
  const hasCardComments = domain.isCard && path.length === 1 && path[0] === 'props' &&
    [base, local, remote].some((props) =>
      props && Object.prototype.hasOwnProperty.call(props, 'comments'))
  if (hasCardComments) {
    groupedKeys.add('comments')
    groupedKeys.add('commentH')
    const result = mergeCardComments({
      base: base?.comments,
      local: local.comments,
      remote: remote.comments,
      recordId,
      conflicts,
      tools: {
        clone: cloneValue,
        equal: structuralEqual,
        merge: (baseComment, localComment, remoteComment, commentPath) => mergeObject(
          baseComment, localComment, remoteComment, recordId, commentPath, conflicts, domain,
        ),
      },
    })
    if (result.ok) values.set('comments', result.comments)
  }
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
  if (hasCardComments) {
    const comments = values.get('comments')
    const width = values.get('w')
    if (Array.isArray(comments) && typeof width === 'number') {
      values.set('commentH', estimateMergedCommentHeight(comments, width))
      if (!keys.includes('commentH')) keys.push('commentH')
      keys.sort()
    }
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
  const forceCardObjectMerge = domain.isCard &&
    (path.length === 0 || (path.length === 1 && path[0] === 'props')) &&
    local !== MISSING && remote !== MISSING && isPlainObject(local) && isPlainObject(remote) &&
    (base === MISSING || isPlainObject(base))
  if (forceCardObjectMerge) {
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
        const source = local === MISSING ? 'remote' : 'local'
        const added = (local === MISSING ? remote : local) as DocumentRecord
        setDocumentRecord(document, recordId, finalizeAddedCardRecord(
          added,
          [source],
          source === 'remote',
          conflicts,
          cloneValue,
        ))
      } else if (structuralEqual(local, remote)) {
        setDocumentRecord(document, recordId, finalizeAddedCardRecord(
          local as DocumentRecord,
          ['local', 'remote'],
          true,
          conflicts,
          cloneValue,
        ))
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
    if (merged !== MISSING) setDocumentRecord(document, recordId, merged as DocumentRecord)
  }

  return conflicts.length > 0 ? { ok: false, conflicts } : { ok: true, document }
}
