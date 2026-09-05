import type { DocumentRecords } from './canvasMerge'
import type { CanvasSnapshot, Project } from './persistence'

export const CANVAS_RECOVERY_FORMAT = 1 as const
const DATABASE_NAME = 'elves-canvas-recovery-v1'
const STORE_NAME = 'entries'
const SESSION_KEY = 'elves:canvas-recovery-session-v1'
const RECOVERY_LEASE_PREFIX = 'elves:canvas-recovery-lease-v1:'
const RECOVERY_LEASE_MS = 5 * 60 * 1_000
const RECOVERY_LEASE_HEARTBEAT_MS = 30 * 1_000

export interface CanvasRecoveryEntry {
  key: string
  format: typeof CANVAS_RECOVERY_FORMAT
  serverOrigin: string
  storageId: string
  projectId: string
  sessionId: string
  generation: number
  createdAt: string
  updatedAt: string
  baseRevision: number
  baseEpoch: string
  baseDocument: DocumentRecords
  localDocument: DocumentRecords
  localSnapshot: CanvasSnapshot
}

export interface CanvasRecoveryStore {
  put(entry: CanvasRecoveryEntry): Promise<void>
  list(serverOrigin: string, storageId: string): Promise<CanvasRecoveryEntry[]>
  deleteIfGeneration(key: string, acknowledgedGeneration: number): Promise<boolean>
  delete(key: string): Promise<void>
}

export interface CanvasRecoveryContext {
  store: CanvasRecoveryStore
  serverOrigin: string
  sessionId: string
  ready?: Promise<void>
  now?: () => string
  activeSessionIds?(): Promise<ReadonlySet<string>>
}

export function recoveryKey(serverOrigin: string, storageId: string, sessionId: string): string {
  return `${serverOrigin}\u0000${storageId}\u0000${sessionId}`
}

export function createRecoveryEntry(input: Omit<CanvasRecoveryEntry, 'key' | 'format'>): CanvasRecoveryEntry {
  return {
    ...input,
    key: recoveryKey(input.serverOrigin, input.storageId, input.sessionId),
    format: CANVAS_RECOVERY_FORMAT,
  }
}

export function isCanvasRecoveryEntry(value: unknown): value is CanvasRecoveryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<CanvasRecoveryEntry>
  return entry.format === CANVAS_RECOVERY_FORMAT && typeof entry.key === 'string' &&
    typeof entry.serverOrigin === 'string' && typeof entry.storageId === 'string' &&
    typeof entry.projectId === 'string' && typeof entry.sessionId === 'string' &&
    Number.isSafeInteger(entry.generation) && (entry.generation ?? -1) >= 0 &&
    typeof entry.createdAt === 'string' && typeof entry.updatedAt === 'string' &&
    Number.isSafeInteger(entry.baseRevision) && (entry.baseRevision ?? -1) >= 0 &&
    typeof entry.baseEpoch === 'string' && !!entry.baseDocument && !!entry.localDocument &&
    !!entry.localSnapshot
}

export class IndexedDbCanvasRecoveryStore implements CanvasRecoveryStore {
  constructor(private readonly indexedDb: IDBFactory) {}

  async put(entry: CanvasRecoveryEntry): Promise<void> {
    const db = await this.open()
    try {
      await transactionResult(db, 'readwrite', (store) => store.put(entry))
    } finally {
      db.close()
    }
  }

  async list(serverOrigin: string, storageId: string): Promise<CanvasRecoveryEntry[]> {
    const db = await this.open()
    try {
      const values = await transactionResult<unknown[]>(db, 'readonly', (store) => store.getAll())
      return values.filter(isCanvasRecoveryEntry)
        .filter((entry) => entry.serverOrigin === serverOrigin && entry.storageId === storageId)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    } finally {
      db.close()
    }
  }

  async deleteIfGeneration(key: string, acknowledgedGeneration: number): Promise<boolean> {
    const db = await this.open()
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite')
        const store = transaction.objectStore(STORE_NAME)
        let deleted = false
        const get = store.get(key)
        get.onerror = () => reject(get.error ?? new Error('recovery journal read failed'))
        get.onsuccess = () => {
          const entry = get.result
          if (isCanvasRecoveryEntry(entry) && entry.generation <= acknowledgedGeneration) {
            store.delete(key)
            deleted = true
          }
        }
        transaction.oncomplete = () => resolve(deleted)
        transaction.onerror = () => reject(transaction.error ?? new Error('recovery journal transaction failed'))
        transaction.onabort = () => reject(transaction.error ?? new Error('recovery journal transaction aborted'))
      })
    } finally {
      db.close()
    }
  }

  async delete(key: string): Promise<void> {
    const db = await this.open()
    try {
      await transactionResult(db, 'readwrite', (store) => store.delete(key))
    } finally {
      db.close()
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = this.indexedDb.open(DATABASE_NAME, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('recovery database open failed'))
    })
  }
}

export class MemoryCanvasRecoveryStore implements CanvasRecoveryStore {
  readonly entries = new Map<string, CanvasRecoveryEntry>()

  async put(entry: CanvasRecoveryEntry): Promise<void> {
    this.entries.set(entry.key, structuredClone(entry))
  }

  async list(serverOrigin: string, storageId: string): Promise<CanvasRecoveryEntry[]> {
    return [...this.entries.values()]
      .filter((entry) => entry.serverOrigin === serverOrigin && entry.storageId === storageId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((entry) => structuredClone(entry))
  }

  async deleteIfGeneration(key: string, acknowledgedGeneration: number): Promise<boolean> {
    const entry = this.entries.get(key)
    if (!entry || entry.generation > acknowledgedGeneration) return false
    this.entries.delete(key)
    return true
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
}

let browserStore: IndexedDbCanvasRecoveryStore | undefined
let browserOwnership: BrowserRecoveryOwnership | undefined

export interface BrowserRecoveryOwnership {
  sessionId: string
  ready: Promise<void>
  activeSessionIds?: () => Promise<ReadonlySet<string>>
}

export function browserRecoveryContext(project: Project): CanvasRecoveryContext | undefined {
  if (!project.storageId || typeof window === 'undefined' || !window.indexedDB) return undefined
  browserStore ??= new IndexedDbCanvasRecoveryStore(window.indexedDB)
  browserOwnership ??= createBrowserRecoveryOwnership(window)
  return {
    store: browserStore,
    serverOrigin: new URL((import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:5199', window.location.href).origin,
    get sessionId() { return browserOwnership!.sessionId },
    ready: browserOwnership.ready,
    activeSessionIds: browserOwnership.activeSessionIds,
  }
}

const ACTIVE_SESSION_PREFIX = 'elves:canvas-recovery-session-v1:'

export function createBrowserRecoveryOwnership(browser: Window): BrowserRecoveryOwnership {
  const ownership: BrowserRecoveryOwnership = {
    sessionId: browserRecoverySessionId(browser.sessionStorage, browser.crypto),
    ready: Promise.resolve(),
  }
  const locks = (browser.navigator as Navigator & { locks?: LockManager }).locks
  if (!locks) {
    ownership.activeSessionIds = browserRecoverySessionLeases(browser, ownership)
    return ownership
  }
  let releaseLock: (() => void) | undefined
  ownership.ready = (async () => {
    const snapshot = await locks.query()
    if (snapshot.held?.some((lock) => lock.name === `${ACTIVE_SESSION_PREFIX}${ownership.sessionId}`)) {
      ownership.sessionId = browser.crypto.randomUUID()
      browser.sessionStorage.setItem(SESSION_KEY, ownership.sessionId)
    }
    const acquired = new Promise<void>((resolve) => {
      void locks.request(`${ACTIVE_SESSION_PREFIX}${ownership.sessionId}`, () => {
        resolve()
        return new Promise<void>((release) => { releaseLock = release })
      })
    })
    await acquired
  })()
  browser.addEventListener('pagehide', (event) => {
    if (!event.persisted) releaseLock?.()
  })
  ownership.activeSessionIds = async (): Promise<ReadonlySet<string>> => {
    await ownership.ready
    const snapshot = await locks.query()
    const active = new Set<string>([ownership.sessionId])
    for (const lock of snapshot.held ?? []) {
      if (lock.name?.startsWith(ACTIVE_SESSION_PREFIX)) active.add(lock.name.slice(ACTIVE_SESSION_PREFIX.length))
    }
    return active
  }
  return ownership
}

function browserRecoverySessionLeases(
  browser: Window,
  ownership: BrowserRecoveryOwnership,
): (() => Promise<ReadonlySet<string>>) | undefined {
  let storage: Storage
  try {
    storage = browser.localStorage
  } catch {
    return undefined
  }
  const ownerId = browser.crypto.randomUUID()
  const leaseKey = () => `${RECOVERY_LEASE_PREFIX}${ownership.sessionId}`
  const readLease = (key: string): { ownerId: string; expiresAt: number } | null => {
    try {
      const value = JSON.parse(storage.getItem(key) ?? 'null') as { ownerId?: unknown; expiresAt?: unknown } | null
      return value && typeof value.ownerId === 'string' && typeof value.expiresAt === 'number'
        ? { ownerId: value.ownerId, expiresAt: value.expiresAt }
        : null
    } catch {
      return null
    }
  }
  const refreshLease = (): boolean => {
    try {
      const existing = readLease(leaseKey())
      if (existing && existing.ownerId !== ownerId && existing.expiresAt > Date.now()) {
        ownership.sessionId = browser.crypto.randomUUID()
        browser.sessionStorage.setItem(SESSION_KEY, ownership.sessionId)
      }
      storage.setItem(leaseKey(), JSON.stringify({ ownerId, expiresAt: Date.now() + RECOVERY_LEASE_MS }))
      return true
    } catch {
      return false
    }
  }
  if (!refreshLease()) return undefined
  const timer = (browser as Window & {
    setInterval?: typeof setInterval
    clearInterval?: typeof clearInterval
  }).setInterval?.(refreshLease, RECOVERY_LEASE_HEARTBEAT_MS)
  browser.addEventListener('pagehide', () => {
    if (timer !== undefined) {
      (browser as Window & { clearInterval?: typeof clearInterval }).clearInterval?.(timer)
    }
    try {
      if (readLease(leaseKey())?.ownerId === ownerId) storage.removeItem(leaseKey())
    } catch {
      // Keep the lease until expiry if the browser refuses storage access during teardown.
    }
  })
  return async () => {
    if (!refreshLease()) return new Set([ownership.sessionId])
    const active = new Set<string>([ownership.sessionId])
    const now = Date.now()
    try {
      const leaseKeys: string[] = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (key?.startsWith(RECOVERY_LEASE_PREFIX)) leaseKeys.push(key)
      }
      for (const key of leaseKeys) {
        const lease = readLease(key)
        if (lease && lease.expiresAt > now) {
          active.add(key.slice(RECOVERY_LEASE_PREFIX.length))
          continue
        }
        try {
          storage.removeItem(key)
        } catch {
          // Expired leases are harmless; leave them for a later best-effort scan.
        }
      }
    } catch {
      return new Set([ownership.sessionId])
    }
    return active
  }
}

export function browserRecoverySessionId(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  cryptoSource: Pick<Crypto, 'randomUUID'>,
): string {
  const existing = storage.getItem(SESSION_KEY)
  if (existing) return existing
  const created = cryptoSource.randomUUID()
  storage.setItem(SESSION_KEY, created)
  return created
}

function transactionResult<T = undefined>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  request: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const result = request(transaction.objectStore(STORE_NAME))
    transaction.oncomplete = () => resolve(result.result as T)
    transaction.onerror = () => reject(transaction.error ?? new Error('recovery journal transaction failed'))
    transaction.onabort = () => reject(transaction.error ?? new Error('recovery journal transaction aborted'))
  })
}
