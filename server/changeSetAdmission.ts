import {
  changeSetTokenStamp,
  mergeRepresentativeIds,
  referencedCardIds,
  referencedGroupIds,
  referencedQuestionIds,
  referencedSectionIds,
  type ChangeSet,
} from '../src/model/changeset'
import { applyChangeSetToSnapshot } from './applyChangeSet'
import {
  addPendingChangeSet,
  canvasRevision,
  compareChangeSetToken,
  consumeChangeSetSequence,
  incrementCanvasRevision,
  legacyChangeSetReceipt,
  nextChangeSetToken,
  recentChangeSetDigest,
  recordLegacyChangeSetReceipt,
  type ChangeSetToken,
} from './canvasMetadata'
import { snapshotToCards, snapshotToGroupIds, snapshotToSections } from './digest'
import type { CanvasSnapshot } from './store'

interface ProtocolState {
  revision: number
  nextToken: ChangeSetToken
}

interface InvalidTarget extends ProtocolState {
  kind: 'invalid-target'
  missing: string[]
  invalidMergeReps: string[]
}

export type TokenizedAdmissionResult =
  | ({ kind: 'applied' | 'queued'; snapshot: CanvasSnapshot } & ProtocolState)
  | ({ kind: 'duplicate'; payloadUnverified: boolean } & ProtocolState)
  | ({
      kind: 'conflict'
      code: 'epoch-mismatch' | 'sequence-ahead' | 'sequence-payload-mismatch'
    } & ProtocolState)
  | ({
      kind: 'exhausted'
      code: 'canvas-revision-exhausted' | 'changeset-sequence-exhausted'
    } & ProtocolState)
  | InvalidTarget
  | ({ kind: 'unavailable'; code: 'pending-full' | 'pending-too-large' | 'no-document' } & ProtocolState)

export type LegacyAdmissionResult =
  | { kind: 'applied'; snapshot: CanvasSnapshot }
  | { kind: 'duplicate' }
  | { kind: 'conflict'; code: 'changeset-id-conflict' }
  | { kind: 'invalid-target'; missing: string[]; invalidMergeReps: string[] }
  | { kind: 'unapplied'; reason: 'no-document' }
  | { kind: 'exhausted'; code: 'canvas-revision-exhausted' }

function protocolState(snapshot: CanvasSnapshot): ProtocolState {
  return { revision: canvasRevision(snapshot), nextToken: nextChangeSetToken(snapshot) }
}

function targetValidation(
  snapshot: CanvasSnapshot,
  changeSet: ChangeSet,
): { missing: string[]; invalidMergeReps: string[] } {
  const cards = snapshotToCards(snapshot)
  const cardIds = new Set(cards.map((card) => card.id))
  const sectionIds = new Set(snapshotToSections(snapshot).map((section) => section.id))
  const groupIds = new Set(snapshotToGroupIds(snapshot))
  const store = (snapshot as any)?.document?.store
  const questionIds = new Set(
    store && typeof store === 'object'
      ? Object.values(store)
        .filter((record: any) => record?.typeName === 'shape' && record.type === 'question')
        .map((record: any) => record.id as string)
      : [],
  )
  const missing = [...new Set([
    ...referencedCardIds(changeSet).filter((id) => !cardIds.has(id)),
    ...referencedSectionIds(changeSet).filter((id) => !sectionIds.has(id)),
    ...referencedGroupIds(changeSet).filter((id) => !groupIds.has(id)),
    ...referencedQuestionIds(changeSet).filter((id) => !questionIds.has(id)),
  ])]
  const noteCardIds = new Set(cards.filter((card) => card.kind === 'note').map((card) => card.id))
  const invalidMergeReps = mergeRepresentativeIds(changeSet)
    .filter((id) => !noteCardIds.has(id))
  return { missing, invalidMergeReps }
}

function isCreateOnly(changeSet: ChangeSet): boolean {
  return changeSet.ops.length > 0 && changeSet.ops.every((op) =>
    op.kind === 'create_note_card' || op.kind === 'create_reference' ||
    op.kind === 'create_section' || op.kind === 'create_figure_card' ||
    op.kind === 'create_question')
}

export function admitTokenizedChangeSet(
  current: CanvasSnapshot,
  token: ChangeSetToken,
  changeSet: ChangeSet,
  digest: string,
): TokenizedAdmissionResult {
  const state = protocolState(current)
  const comparison = compareChangeSetToken(current, token)
  if (comparison === 'epoch-mismatch' || comparison === 'sequence-ahead') {
    return { kind: 'conflict', code: comparison, ...state }
  }
  if (comparison === 'consumed') {
    const retained = recentChangeSetDigest(current, token.sequence)
    if (retained !== undefined && retained !== digest) {
      return { kind: 'conflict', code: 'sequence-payload-mismatch', ...state }
    }
    return { kind: 'duplicate', payloadUnverified: retained === undefined, ...state }
  }
  if (state.nextToken.sequence >= Number.MAX_SAFE_INTEGER) {
    return { kind: 'exhausted', code: 'changeset-sequence-exhausted', ...state }
  }
  if (state.revision >= Number.MAX_SAFE_INTEGER) {
    return { kind: 'exhausted', code: 'canvas-revision-exhausted', ...state }
  }

  const invalid = targetValidation(current, changeSet)
  if (invalid.missing.length > 0 || invalid.invalidMergeReps.length > 0) {
    return { kind: 'invalid-target', ...invalid, ...state }
  }

  const applied = applyChangeSetToSnapshot(current, changeSet, changeSetTokenStamp(token))
  if (applied) {
    const snapshot = consumeChangeSetSequence(applied, digest)
    return { kind: 'applied', snapshot, ...protocolState(snapshot) }
  }
  if (!isCreateOnly(changeSet)) {
    return { kind: 'unavailable', code: 'no-document', ...state }
  }
  const pending = addPendingChangeSet(current, changeSet, digest)
  if (pending.status !== 'added') {
    return {
      kind: 'unavailable',
      code: pending.status === 'full' ? 'pending-full' : 'pending-too-large',
      ...state,
    }
  }
  return { kind: 'queued', snapshot: pending.snapshot, ...protocolState(pending.snapshot) }
}

export function admitLegacyChangeSet(
  current: CanvasSnapshot,
  changeSet: ChangeSet,
  digest: string,
): LegacyAdmissionResult {
  const prior = legacyChangeSetReceipt(current, changeSet.id)
  if (prior !== undefined) {
    return prior === digest
      ? { kind: 'duplicate' }
      : { kind: 'conflict', code: 'changeset-id-conflict' }
  }
  if (canvasRevision(current) >= Number.MAX_SAFE_INTEGER) {
    return { kind: 'exhausted', code: 'canvas-revision-exhausted' }
  }
  const invalid = targetValidation(current, changeSet)
  if (invalid.missing.length > 0 || invalid.invalidMergeReps.length > 0) {
    return { kind: 'invalid-target', ...invalid }
  }
  const applied = applyChangeSetToSnapshot(current, changeSet)
  if (!applied) return { kind: 'unapplied', reason: 'no-document' }
  const withReceipt = recordLegacyChangeSetReceipt(applied, changeSet.id, digest)
  return { kind: 'applied', snapshot: incrementCanvasRevision(withReceipt) }
}
