import { randomUUID } from 'node:crypto'
import {
  CHANGE_SET_STAMP_META_KEY,
  changeSetTokenStamp,
  isChangeSet,
  type ChangeSet,
  type Op,
} from '../src/model/changeset'
import {
  changeSetDigest,
  semanticChangeSet,
  semanticChangeSetJson,
  validateChangeSetBounds,
} from './changeSetIdentity'
import type { CanvasSnapshot } from './store'

export const SERVER_CANVAS_METADATA_KEY = '__elves'
export const MAX_RECENT_CHANGE_SET_DIGESTS = 256
export const MAX_LEGACY_CHANGE_SET_RECEIPTS = 256
export const MAX_PENDING_CHANGE_SETS = 32
export const MAX_PENDING_CHANGE_SET_BYTES = 4_000_000

export interface ChangeSetToken {
  epoch: string
  sequence: number
}

export interface PendingChangeSetV2 {
  token: ChangeSetToken
  changeSet: ChangeSet
}

interface RecentChangeSetDigest {
  sequence: number
  digest: string
}

interface StoredPendingChangeSet extends PendingChangeSetV2 {
  digest: string
}

interface LegacyChangeSetReceipt {
  id: string
  digest: string
}

interface ServerCanvasMetadata {
  revision: number
  epoch: string
  nextSequence: number
  recentDigests: RecentChangeSetDigest[]
  pendingChangeSets: StoredPendingChangeSet[]
  legacyReceipts: LegacyChangeSetReceipt[]
}

export class InvalidCanvasMetadataError extends Error {
  constructor() {
    super('invalid server canvas metadata')
    this.name = 'InvalidCanvasMetadataError'
  }
}

export class CanvasRevisionExhaustedError extends Error {
  constructor() {
    super('canvas revision exhausted')
    this.name = 'CanvasRevisionExhaustedError'
  }
}

export class ChangeSetSequenceExhaustedError extends Error {
  constructor() {
    super('change-set sequence exhausted')
    this.name = 'ChangeSetSequenceExhaustedError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isToken(value: unknown): value is ChangeSetToken {
  return isRecord(value) && typeof value.epoch === 'string' && value.epoch.length > 0 &&
    isNonNegativeSafeInteger(value.sequence)
}

function invalidMetadata(): never {
  throw new InvalidCanvasMetadataError()
}

function metadataFrom(snapshot: CanvasSnapshot): ServerCanvasMetadata | null {
  if (!Object.prototype.hasOwnProperty.call(snapshot, SERVER_CANVAS_METADATA_KEY)) return null
  const raw = snapshot[SERVER_CANVAS_METADATA_KEY]
  if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.revision) ||
    typeof raw.epoch !== 'string' || raw.epoch.length === 0 ||
    !isNonNegativeSafeInteger(raw.nextSequence) ||
    !Array.isArray(raw.recentDigests) || !Array.isArray(raw.pendingChangeSets) ||
    !Array.isArray(raw.legacyReceipts)) return invalidMetadata()

  if (raw.recentDigests.length > MAX_RECENT_CHANGE_SET_DIGESTS ||
    raw.pendingChangeSets.length > MAX_PENDING_CHANGE_SETS ||
    raw.legacyReceipts.length > MAX_LEGACY_CHANGE_SET_RECEIPTS) return invalidMetadata()

  const recentDigests: RecentChangeSetDigest[] = []
  let previousSequence = -1
  for (const entry of raw.recentDigests) {
    if (!isRecord(entry) || !isNonNegativeSafeInteger(entry.sequence) ||
      entry.sequence >= raw.nextSequence || entry.sequence <= previousSequence ||
      typeof entry.digest !== 'string' || entry.digest.length === 0) return invalidMetadata()
    previousSequence = entry.sequence
    recentDigests.push({ sequence: entry.sequence, digest: entry.digest })
  }

  const pendingChangeSets: StoredPendingChangeSet[] = []
  const recentDigestBySequence = new Map(
    recentDigests.map((entry) => [entry.sequence, entry.digest]),
  )
  let pendingBytes = 0
  let previousPendingSequence = -1
  for (const entry of raw.pendingChangeSets) {
    if (!isRecord(entry) || !isToken(entry.token) || entry.token.epoch !== raw.epoch ||
      entry.token.sequence >= raw.nextSequence || typeof entry.digest !== 'string' ||
      entry.digest.length === 0) return invalidMetadata()
    if (entry.token.sequence <= previousPendingSequence ||
      recentDigestBySequence.get(entry.token.sequence) !== entry.digest) return invalidMetadata()
    previousPendingSequence = entry.token.sequence
    if (!isChangeSet(entry.changeSet) || !validateChangeSetBounds(entry.changeSet).ok ||
      changeSetDigest(entry.changeSet) !== entry.digest) return invalidMetadata()
    const changeSet = semanticChangeSet(entry.changeSet)
    pendingBytes += Buffer.byteLength(semanticChangeSetJson(changeSet), 'utf8')
    if (pendingBytes > MAX_PENDING_CHANGE_SET_BYTES) return invalidMetadata()
    pendingChangeSets.push({
      token: { epoch: entry.token.epoch, sequence: entry.token.sequence },
      digest: entry.digest,
      changeSet,
    })
  }

  const legacyReceipts: LegacyChangeSetReceipt[] = []
  const legacyIds = new Set<string>()
  for (const entry of raw.legacyReceipts) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.digest !== 'string' ||
      entry.digest.length === 0 || legacyIds.has(entry.id)) return invalidMetadata()
    legacyIds.add(entry.id)
    legacyReceipts.push({ id: entry.id, digest: entry.digest })
  }

  return {
    revision: raw.revision,
    epoch: raw.epoch,
    nextSequence: raw.nextSequence,
    recentDigests,
    pendingChangeSets,
    legacyReceipts,
  }
}

function newMetadata(): ServerCanvasMetadata {
  return {
    revision: 0,
    epoch: randomUUID(),
    nextSequence: 0,
    recentDigests: [],
    pendingChangeSets: [],
    legacyReceipts: [],
  }
}

function metadataForMutation(snapshot: CanvasSnapshot): ServerCanvasMetadata {
  return metadataFrom(snapshot) ?? newMetadata()
}

function withMetadata(snapshot: CanvasSnapshot, metadata: ServerCanvasMetadata): CanvasSnapshot {
  return { ...snapshot, [SERVER_CANVAS_METADATA_KEY]: metadata }
}

function nextRevision(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) throw new CanvasRevisionExhaustedError()
  return revision + 1
}

function nextSequence(sequence: number): number {
  if (sequence >= Number.MAX_SAFE_INTEGER) throw new ChangeSetSequenceExhaustedError()
  return sequence + 1
}

export function ensureCanvasMetadata(
  snapshot: CanvasSnapshot,
): { snapshot: CanvasSnapshot; created: boolean } {
  const existing = metadataFrom(snapshot)
  if (existing) return { snapshot, created: false }
  return { snapshot: withMetadata(snapshot, newMetadata()), created: true }
}

export function publicCanvasSnapshot(snapshot: CanvasSnapshot): CanvasSnapshot {
  metadataFrom(snapshot)
  const { [SERVER_CANVAS_METADATA_KEY]: _metadata, ...publicSnapshot } = snapshot
  return publicSnapshot
}

export function canvasRevision(snapshot: CanvasSnapshot): number {
  return metadataFrom(snapshot)?.revision ?? 0
}

export function nextChangeSetToken(snapshot: CanvasSnapshot): ChangeSetToken {
  const metadata = metadataForMutation(snapshot)
  return { epoch: metadata.epoch, sequence: metadata.nextSequence }
}

export function pendingChangeSetsForClient(snapshot: CanvasSnapshot): PendingChangeSetV2[] {
  const metadata = metadataFrom(snapshot)
  if (!metadata) return []
  return metadata.pendingChangeSets.map((entry) => ({
    token: { ...entry.token },
    changeSet: semanticChangeSet(entry.changeSet),
  }))
}

export function incrementCanvasRevision(snapshot: CanvasSnapshot): CanvasSnapshot {
  const metadata = metadataForMutation(snapshot)
  return withMetadata(snapshot, { ...metadata, revision: nextRevision(metadata.revision) })
}

export type ChangeSetTokenComparison =
  | 'epoch-mismatch'
  | 'sequence-ahead'
  | 'current'
  | 'consumed'

export function compareChangeSetToken(
  snapshot: CanvasSnapshot,
  token: ChangeSetToken,
): ChangeSetTokenComparison {
  const metadata = metadataForMutation(snapshot)
  if (token.epoch !== metadata.epoch) return 'epoch-mismatch'
  if (token.sequence > metadata.nextSequence) return 'sequence-ahead'
  if (token.sequence < metadata.nextSequence) return 'consumed'
  return 'current'
}

function consumedMetadata(metadata: ServerCanvasMetadata, digest: string): ServerCanvasMetadata {
  const sequence = metadata.nextSequence
  const recentDigests = [...metadata.recentDigests, { sequence, digest }]
    .slice(-MAX_RECENT_CHANGE_SET_DIGESTS)
  return {
    ...metadata,
    revision: nextRevision(metadata.revision),
    nextSequence: nextSequence(sequence),
    recentDigests,
  }
}

export function consumeChangeSetSequence(snapshot: CanvasSnapshot, digest: string): CanvasSnapshot {
  return withMetadata(snapshot, consumedMetadata(metadataForMutation(snapshot), digest))
}

export function recentChangeSetDigest(snapshot: CanvasSnapshot, sequence: number): string | undefined {
  return metadataFrom(snapshot)?.recentDigests.find((entry) => entry.sequence === sequence)?.digest
}

export type AddPendingChangeSetResult =
  | { status: 'added'; snapshot: CanvasSnapshot }
  | { status: 'full' | 'too-large'; snapshot: null }

export function addPendingChangeSet(
  snapshot: CanvasSnapshot,
  changeSet: ChangeSet,
  digest: string,
): AddPendingChangeSetResult {
  const metadata = metadataForMutation(snapshot)
  if (metadata.pendingChangeSets.length >= MAX_PENDING_CHANGE_SETS) {
    return { status: 'full', snapshot: null }
  }
  const semantic = semanticChangeSet(changeSet)
  const bytes = Buffer.byteLength(semanticChangeSetJson(semantic), 'utf8')
  const currentBytes = metadata.pendingChangeSets.reduce(
    (total, entry) => total + Buffer.byteLength(semanticChangeSetJson(entry.changeSet), 'utf8'),
    0,
  )
  if (currentBytes + bytes > MAX_PENDING_CHANGE_SET_BYTES) {
    return { status: 'too-large', snapshot: null }
  }
  const token = { epoch: metadata.epoch, sequence: metadata.nextSequence }
  const consumed = consumedMetadata(metadata, digest)
  return {
    status: 'added',
    snapshot: withMetadata(snapshot, {
      ...consumed,
      pendingChangeSets: [...metadata.pendingChangeSets, { token, digest, changeSet: semantic }],
    }),
  }
}

export function legacyChangeSetReceipt(snapshot: CanvasSnapshot, id: string): string | undefined {
  return metadataFrom(snapshot)?.legacyReceipts.find((entry) => entry.id === id)?.digest
}

export function recordLegacyChangeSetReceipt(
  snapshot: CanvasSnapshot,
  id: string,
  digest: string,
): CanvasSnapshot {
  const metadata = metadataForMutation(snapshot)
  const legacyReceipts = [
    ...metadata.legacyReceipts.filter((entry) => entry.id !== id),
    { id, digest },
  ].slice(-MAX_LEGACY_CHANGE_SET_RECEIPTS)
  return withMetadata(snapshot, { ...metadata, legacyReceipts })
}

type CreatedRecordKind = Extract<Op, { kind: `create_${string}` }>['kind']

function expectedCreatedKinds(changeSet: ChangeSet): CreatedRecordKind[] | null {
  const kinds: CreatedRecordKind[] = []
  for (const op of changeSet.ops) {
    switch (op.kind) {
      case 'create_note_card':
      case 'create_reference':
      case 'create_figure_card':
      case 'create_section':
      case 'create_question':
        kinds.push(op.kind)
        break
      default:
        return null
    }
  }
  return kinds.length > 0 ? kinds : null
}

function createdRecordKind(record: unknown): CreatedRecordKind | null {
  if (!isRecord(record) || record.typeName !== 'shape' || !isRecord(record.props)) return null
  if (record.type === 'section') return 'create_section'
  if (record.type === 'question') return 'create_question'
  if (record.type !== 'card') return null
  if (record.props.kind === 'figure') return 'create_figure_card'
  if (record.props.kind !== 'note') return null
  return record.props.noteKind === 'reference' ? 'create_reference' : 'create_note_card'
}

function pendingEntryIsMaterialized(
  incoming: CanvasSnapshot,
  entry: StoredPendingChangeSet,
): boolean {
  const expected = expectedCreatedKinds(entry.changeSet)
  if (!expected) return false
  const document = incoming.document
  if (!isRecord(document) || !isRecord(document.store)) return false
  const stamp = changeSetTokenStamp(entry.token)
  const actual: CreatedRecordKind[] = []
  for (const record of Object.values(document.store)) {
    if (!isRecord(record) || !isRecord(record.meta) ||
      record.meta[CHANGE_SET_STAMP_META_KEY] !== stamp) continue
    const kind = createdRecordKind(record)
    if (!kind) return false
    actual.push(kind)
  }
  if (actual.length !== expected.length) return false
  actual.sort()
  expected.sort()
  return actual.every((kind, index) => kind === expected[index])
}

interface ReplaceCanvasSnapshotOptions {
  materializePending?: boolean
}

export function replaceCanvasSnapshot(
  current: CanvasSnapshot,
  incoming: CanvasSnapshot,
  options: ReplaceCanvasSnapshotOptions = {},
): CanvasSnapshot {
  const metadata = metadataForMutation(current)
  const { [SERVER_CANVAS_METADATA_KEY]: _forged, ...publicIncoming } = incoming
  const pendingChangeSets = options.materializePending
    ? metadata.pendingChangeSets.filter((entry) => !pendingEntryIsMaterialized(publicIncoming, entry))
    : metadata.pendingChangeSets
  return withMetadata(publicIncoming, {
    ...metadata,
    revision: nextRevision(metadata.revision),
    pendingChangeSets,
  })
}

export function clearCanvasSnapshot(current: CanvasSnapshot): CanvasSnapshot {
  const metadata = metadataForMutation(current)
  return withMetadata(
    { document: null, session: null },
    { ...newMetadata(), revision: nextRevision(metadata.revision) },
  )
}
