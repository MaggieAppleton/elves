import type { CanvasSnapshot } from './store'

export type StoreRecord = Record<string, unknown>

export interface GlobalStoreIdentity {
  addressableById: Map<string, StoreRecord>
  unaddressableIds: Set<string>
}

function isRecord(value: unknown): value is StoreRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Index every record id in the document store once. An id is addressable only
 * when exactly one record owns it and that record sits at `store[id]`, matching
 * the lookup contract used by snapshot mutation helpers.
 */
export function globalStoreIdentity(snapshot: CanvasSnapshot): GlobalStoreIdentity {
  const document = isRecord(snapshot.document) ? snapshot.document : null
  const store = document && isRecord(document.store) ? document.store : {}
  const groups = new Map<string, Array<{ storeKey: string; record: StoreRecord }>>()
  for (const [storeKey, record] of Object.entries(store)) {
    if (!isRecord(record) || typeof record.id !== 'string') continue
    const group = groups.get(record.id)
    const entry = { storeKey, record }
    if (group) group.push(entry)
    else groups.set(record.id, [entry])
  }

  const addressableById = new Map<string, StoreRecord>()
  const unaddressableIds = new Set<string>()
  for (const [id, group] of groups) {
    if (group.length === 1 && group[0].storeKey === id) {
      addressableById.set(id, group[0].record)
    } else {
      unaddressableIds.add(id)
    }
  }
  return { addressableById, unaddressableIds }
}

export function addressableShapeRecord(
  identity: GlobalStoreIdentity,
  id: string,
  type: string,
): StoreRecord | null {
  const record = identity.addressableById.get(id)
  return record?.typeName === 'shape' && record.type === type ? record : null
}
