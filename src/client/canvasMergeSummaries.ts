import { summaryHash } from '../model/summary'
import type { DocumentRecord } from './canvasMergeTypes'

export const SUMMARY_KEYS = [
  'summary', 'summaryOfHash', 'summaryBy', 'summaryAt',
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function finalizeSummary(value: Record<string, unknown>): void {
  if (!SUMMARY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(value, key))) return
  const isComplete = SUMMARY_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  if (isComplete && typeof value.text === 'string' &&
    value.summaryOfHash === summaryHash(value.text)) return
  for (const key of SUMMARY_KEYS) setOwn(value, key, null)
}

export function finalizeRecordSummaries(record: DocumentRecord): DocumentRecord {
  if (record.typeName !== 'shape' || (record.type !== 'card' && record.type !== 'question') ||
    !isObject(record.props)) return record

  finalizeSummary(record.props)
  if (record.type === 'card' && Array.isArray(record.props.comments)) {
    for (const comment of record.props.comments) {
      if (isObject(comment)) finalizeSummary(comment)
    }
  }
  return record
}
