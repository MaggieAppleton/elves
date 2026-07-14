import { estimateCommentHeight } from '../model/comments'
import type { Comment } from '../model/types'
import type {
  CanvasMergeConflict,
  CanvasMergeSource,
  DocumentRecord,
} from './canvasMergeTypes'

type CommentRecord = Record<string, unknown>

export interface CommentMergeTools {
  clone(value: CommentRecord): CommentRecord
  equal(left: unknown, right: unknown): boolean
  merge(
    base: CommentRecord,
    local: CommentRecord,
    remote: CommentRecord,
    path: string[],
  ): CommentRecord
}

interface CommentMergeInput {
  base: unknown
  local: unknown
  remote: unknown
  recordId: string
  conflicts: CanvasMergeConflict[]
  tools: CommentMergeTools
}

type CommentMergeResult =
  | { ok: true; comments: CommentRecord[] }
  | { ok: false }

function isObject(value: unknown): value is CommentRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function indexComments(
  value: unknown,
  source: CanvasMergeSource,
  recordId: string,
  conflicts: CanvasMergeConflict[],
): Map<string, CommentRecord> | null {
  if (!Array.isArray(value)) {
    conflicts.push({
      kind: 'invalid-comment', source, recordId,
      path: ['props', 'comments'], reason: 'invalid-list',
    })
    return null
  }

  const indexed = new Map<string, CommentRecord>()
  const duplicateIds = new Set<string>()
  value.forEach((entry, position) => {
    if (!isObject(entry) || !Object.prototype.hasOwnProperty.call(entry, 'id')) {
      conflicts.push({
        kind: 'invalid-comment', source, recordId,
        path: ['props', 'comments', String(position), 'id'], reason: 'missing-id',
      })
      return
    }
    if (typeof entry.id !== 'string') {
      conflicts.push({
        kind: 'invalid-comment', source, recordId,
        path: ['props', 'comments', String(position), 'id'], reason: 'non-string-id',
      })
      return
    }
    if (!Object.prototype.hasOwnProperty.call(entry, 'text')) {
      conflicts.push({
        kind: 'invalid-comment', source, recordId,
        path: ['props', 'comments', String(position), 'text'], reason: 'missing-text',
      })
      return
    }
    if (typeof entry.text !== 'string') {
      conflicts.push({
        kind: 'invalid-comment', source, recordId,
        path: ['props', 'comments', String(position), 'text'], reason: 'non-string-text',
      })
      return
    }
    if (indexed.has(entry.id)) duplicateIds.add(entry.id)
    else indexed.set(entry.id, entry)
  })
  for (const id of [...duplicateIds].sort()) {
    conflicts.push({
      kind: 'invalid-comment', source, recordId,
      path: ['props', 'comments', id], reason: 'duplicate-id',
    })
  }
  return indexed
}

function validateCardComments(
  value: unknown,
  source: CanvasMergeSource,
  recordId: string,
  conflicts: CanvasMergeConflict[],
): boolean {
  const conflictCount = conflicts.length
  indexComments(value, source, recordId, conflicts)
  return conflicts.length === conflictCount
}

export function finalizeAddedCardRecord(
  record: DocumentRecord,
  sources: readonly CanvasMergeSource[],
  preserveInputOrder: boolean,
  conflicts: CanvasMergeConflict[],
  clone: <T>(value: T) => T,
): DocumentRecord {
  const cloned = clone(record)
  if (record.typeName !== 'shape' || record.type !== 'card' || !isObject(record.props) ||
    !Object.prototype.hasOwnProperty.call(record.props, 'comments')) return cloned

  let isValid = true
  for (const source of sources) {
    if (!validateCardComments(record.props.comments, source, record.id, conflicts)) isValid = false
  }
  if (!isValid || !isObject(cloned.props) || !Array.isArray(cloned.props.comments)) return cloned

  const comments = preserveInputOrder
    ? cloned.props.comments
    : [...cloned.props.comments].sort((left, right) => {
        const leftId = (left as CommentRecord).id as string
        const rightId = (right as CommentRecord).id as string
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
      })
  Object.defineProperty(cloned.props, 'comments', {
    value: comments, enumerable: true, configurable: true, writable: true,
  })
  if (typeof cloned.props.w === 'number') {
    Object.defineProperty(cloned.props, 'commentH', {
      value: estimateMergedCommentHeight(comments, cloned.props.w),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return cloned
}

export function mergeCardComments(input: CommentMergeInput): CommentMergeResult {
  const conflictCount = input.conflicts.length
  const base = indexComments(input.base, 'base', input.recordId, input.conflicts)
  const local = indexComments(input.local, 'local', input.recordId, input.conflicts)
  const remote = indexComments(input.remote, 'remote', input.recordId, input.conflicts)
  if (!base || !local || !remote || input.conflicts.length !== conflictCount) return { ok: false }

  const merged = new Map<string, CommentRecord>()
  const ids = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort()
  for (const id of ids) {
    const baseComment = base.get(id)
    const localComment = local.get(id)
    const remoteComment = remote.get(id)
    const path = ['props', 'comments', id]

    if (!baseComment) {
      if (localComment && remoteComment) {
        if (input.tools.equal(localComment, remoteComment)) {
          merged.set(id, input.tools.clone(localComment))
        } else {
          input.conflicts.push({ kind: 'comment-addition-conflict', recordId: input.recordId, path })
        }
      } else {
        const added = localComment ?? remoteComment
        if (added) merged.set(id, input.tools.clone(added))
      }
      continue
    }

    if (!localComment && !remoteComment) continue
    if (!localComment || !remoteComment) {
      const retained = localComment ?? remoteComment
      if (retained && !input.tools.equal(retained, baseComment)) {
        input.conflicts.push({ kind: 'comment-delete-edit-conflict', recordId: input.recordId, path })
      }
      continue
    }

    merged.set(id, input.tools.merge(baseComment, localComment, remoteComment, path))
  }

  if (input.conflicts.length !== conflictCount) return { ok: false }

  const comments: CommentRecord[] = []
  const emitted = new Set<string>()
  for (const id of remote.keys()) {
    const comment = merged.get(id)
    if (comment) {
      comments.push(comment)
      emitted.add(id)
    }
  }
  for (const id of [...merged.keys()].filter((id) => !emitted.has(id)).sort()) {
    comments.push(merged.get(id)!)
  }
  return { ok: true, comments }
}

export function estimateMergedCommentHeight(comments: CommentRecord[], width: number): number {
  return estimateCommentHeight(comments as unknown as Comment[], width)
}
