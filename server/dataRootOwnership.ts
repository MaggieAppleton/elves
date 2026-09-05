import { createHash, randomUUID } from 'node:crypto'
import { open, lstat, mkdir, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { hostname as localHostname, userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const OWNER_FILE = 'owner.json'
const OWNER_FORMAT = 1
const TRANSITION_RETRIES = 40
const TRANSITION_DELAY_MS = 25

export interface DataRootOwner {
  pid: number
  hostname: string
  startedAt: string
  instanceId: string
  format: 1
  canonicalRoot: string
}

export type PidProbeResult = 'live' | 'absent' | 'ambiguous'

interface OwnershipOptions {
  runtimeRoot?: string
  hostname?: string
  pid?: number
  instanceId?: string
  now?: () => string
  probePid?: (pid: number) => PidProbeResult
}

interface RecoveryOptions extends OwnershipOptions {
  force: boolean
}

export interface DataRootOwnership {
  canonicalRoot: string
  markerPath: string
  owner: DataRootOwner
  release: () => Promise<boolean>
}

export class DataRootOwnershipError extends Error {
  readonly canonicalRoot: string
  readonly markerPath: string
  readonly owner?: DataRootOwner

  constructor(message: string, canonicalRoot: string, markerPath: string, owner?: DataRootOwner) {
    super(message)
    this.name = 'DataRootOwnershipError'
    this.canonicalRoot = canonicalRoot
    this.markerPath = markerPath
    this.owner = owner
  }
}

/** Resolve symlink aliases without requiring the final data directory to exist. */
export async function canonicalDataRoot(dataRoot: string): Promise<string> {
  let existing = resolve(dataRoot)
  const missing: string[] = []
  for (;;) {
    try {
      return join(await realpath(existing), ...missing)
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.unshift(basename(existing))
      existing = parent
    }
  }
}

/** OS-account state is stable even when TMPDIR differs between launch shells. */
export function defaultOwnershipRuntimeRoot(): string {
  return join(userInfo().homedir, '.local', 'state', 'elves', 'data-owner-v1')
}

export function ownershipMarkerPath(canonicalRoot: string, runtimeRoot = defaultOwnershipRuntimeRoot()): string {
  const key = createHash('sha256').update(canonicalRoot).digest('hex')
  return join(runtimeRoot, key)
}

export async function acquireDataRootOwnership(
  dataRoot: string,
  options: OwnershipOptions = {},
): Promise<DataRootOwnership> {
  const canonicalRoot = await canonicalDataRoot(dataRoot)
  const runtimeRoot = options.runtimeRoot ?? defaultOwnershipRuntimeRoot()
  const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
  await assertExternalMarker(canonicalRoot, markerPath)
  const owner: DataRootOwner = {
    pid: options.pid ?? process.pid,
    hostname: options.hostname ?? localHostname(),
    startedAt: (options.now ?? (() => new Date().toISOString()))(),
    instanceId: options.instanceId ?? randomUUID(),
    format: OWNER_FORMAT,
    canonicalRoot,
  }
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
    if (await hasOwnershipTransition(markerPath)) {
      await delay(TRANSITION_DELAY_MS)
      continue
    }
    try {
      await mkdir(markerPath, { mode: 0o700 })
    } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error
      if (await hasOwnershipTransition(markerPath)) {
        await delay(TRANSITION_DELAY_MS)
        continue
      }
      throw await occupiedError(canonicalRoot, markerPath, options)
    }

    // A releaser may have installed its guard between our first check and the
    // atomic mkdir. Our marker is still empty, so withdraw it and retry.
    if (await hasOwnershipTransition(markerPath)) {
      await rm(markerPath, { recursive: true, force: true })
      await delay(TRANSITION_DELAY_MS)
      continue
    }
    try {
      await writeOwnerAtomically(markerPath, owner)
    } catch (error) {
      await rm(markerPath, { recursive: true, force: true })
      throw error
    }
    return {
      canonicalRoot,
      markerPath,
      owner,
      release: () => releaseOwnedMarker(markerPath, owner),
    }
  }
  throw new DataRootOwnershipError(
    ownershipMessage(canonicalRoot, markerPath, 'ownership recovery or shutdown is still in progress'),
    canonicalRoot,
    markerPath,
  )
}

export async function recoverDataRootOwnership(
  dataRoot: string,
  options: RecoveryOptions,
): Promise<{ recovered: true; canonicalRoot: string; markerPath: string }> {
  const canonicalRoot = await canonicalDataRoot(dataRoot)
  const runtimeRoot = options.runtimeRoot ?? defaultOwnershipRuntimeRoot()
  const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
  await assertExternalMarker(canonicalRoot, markerPath)
  const first = await readOwnerInspection(markerPath)
  const existingArtifacts = await ownershipTransitionArtifacts(markerPath)
  if (!first.exists && existingArtifacts.length === 0) {
    throw new DataRootOwnershipError(`No Elves ownership marker exists at ${markerPath}.`, canonicalRoot, markerPath)
  }
  ensureOwnerMatchesRoot(first.owner, canonicalRoot, markerPath)
  ensureRecoverable(first.owner, canonicalRoot, markerPath, options)
  if (!options.force) {
    throw new DataRootOwnershipError(
      `${ownershipMessage(canonicalRoot, markerPath, first.reason)} Re-run with --force after stopping every candidate Elves server.`,
      canonicalRoot,
      markerPath,
      first.owner,
    )
  }

  const recoveryGuard = `${markerPath}.recovery-${randomUUID()}`
  await mkdir(recoveryGuard, { mode: 0o700 })
  try {
    const current = await readOwnerInspection(markerPath)
    if (current.identity !== first.identity) {
      throw new DataRootOwnershipError(
        ownershipMessage(canonicalRoot, markerPath, 'the marker changed while recovery was being prepared'),
        canonicalRoot,
        markerPath,
        current.owner,
      )
    }
    ensureOwnerMatchesRoot(current.owner, canonicalRoot, markerPath)
    ensureRecoverable(current.owner, canonicalRoot, markerPath, options)
    if (current.exists) {
      const quarantine = `${markerPath}.recovered-${randomUUID()}`
      await rename(markerPath, quarantine)
    }
    for (const artifact of await ownershipTransitionArtifacts(markerPath)) {
      if (artifact !== recoveryGuard) await rm(artifact, { recursive: true, force: true })
    }
    return { recovered: true, canonicalRoot, markerPath }
  } finally {
    await rm(recoveryGuard, { recursive: true, force: true })
  }
}

async function releaseOwnedMarker(markerPath: string, owner: DataRootOwner): Promise<boolean> {
  const transitionPath = `${markerPath}.transition`
  try {
    await mkdir(transitionPath, { mode: 0o700 })
  } catch (error) {
    if (hasCode(error, 'EEXIST')) return false
    throw error
  }
  try {
    const current = await readOwnerInspection(markerPath)
    if (!current.owner || current.owner.instanceId !== owner.instanceId ||
      current.owner.canonicalRoot !== owner.canonicalRoot) return false
    const quarantine = `${markerPath}.released-${owner.instanceId}`
    await rename(markerPath, quarantine)
    await rm(quarantine, { recursive: true, force: true })
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  } finally {
    await rm(transitionPath, { recursive: true, force: true })
  }
}

async function writeOwnerAtomically(markerPath: string, owner: DataRootOwner): Promise<void> {
  const temporary = join(markerPath, `.owner-${owner.instanceId}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, join(markerPath, OWNER_FILE))
  const directory = await open(markerPath, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

async function occupiedError(
  canonicalRoot: string,
  markerPath: string,
  options: OwnershipOptions,
): Promise<DataRootOwnershipError> {
  const inspection = await readOwnerInspection(markerPath)
  const owner = inspection.owner
  let reason = inspection.reason
  if (owner && owner.canonicalRoot !== canonicalRoot) {
    reason = `marker metadata names a different canonical root (${owner.canonicalRoot})`
  } else if (owner && owner.hostname !== (options.hostname ?? localHostname())) {
    reason = `owned on host ${owner.hostname} by PID ${owner.pid}`
  } else if (owner) {
    const liveness = (options.probePid ?? probePid)(owner.pid)
    reason = liveness === 'live'
      ? `already owned by live PID ${owner.pid} on ${owner.hostname}`
      : liveness === 'absent'
        ? `left by absent PID ${owner.pid} on ${owner.hostname}; normal startup will not reclaim it`
        : `PID ${owner.pid} on ${owner.hostname} could not be checked conclusively`
  }
  return new DataRootOwnershipError(ownershipMessage(canonicalRoot, markerPath, reason), canonicalRoot, markerPath, owner)
}

function ensureOwnerMatchesRoot(
  owner: DataRootOwner | undefined,
  canonicalRoot: string,
  markerPath: string,
): void {
  if (!owner || owner.canonicalRoot === canonicalRoot) return
  throw new DataRootOwnershipError(
    ownershipMessage(
      canonicalRoot,
      markerPath,
      `marker metadata names a different canonical root (${owner.canonicalRoot})`,
    ),
    canonicalRoot,
    markerPath,
    owner,
  )
}

function ensureRecoverable(
  owner: DataRootOwner | undefined,
  canonicalRoot: string,
  markerPath: string,
  options: OwnershipOptions,
): void {
  if (!owner || owner.hostname !== (options.hostname ?? localHostname())) return
  const liveness = (options.probePid ?? probePid)(owner.pid)
  if (liveness === 'live') {
    throw new DataRootOwnershipError(
      ownershipMessage(canonicalRoot, markerPath, `PID ${owner.pid} on ${owner.hostname} is still live`),
      canonicalRoot,
      markerPath,
      owner,
    )
  }
  if (liveness === 'ambiguous') {
    throw new DataRootOwnershipError(
      ownershipMessage(canonicalRoot, markerPath, `PID ${owner.pid} on ${owner.hostname} could not be checked conclusively`),
      canonicalRoot,
      markerPath,
      owner,
    )
  }
}

function ownershipMessage(canonicalRoot: string, markerPath: string, reason: string): string {
  return `Elves data root ${canonicalRoot} is unavailable: ${reason}. Ownership marker: ${markerPath}. ` +
    `Inspect it, stop all candidate servers, then run npm run data:recover -- --data-root ${shellQuote(canonicalRoot)} --force.`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function probePid(pid: number): PidProbeResult {
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return 'absent'
    if (hasCode(error, 'EPERM')) return 'live'
    return 'ambiguous'
  }
}

async function readOwnerInspection(markerPath: string): Promise<{
  exists: boolean
  identity: string
  owner?: DataRootOwner
  reason: string
}> {
  let markerStat
  try {
    markerStat = await lstat(markerPath)
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return { exists: false, identity: 'missing', reason: 'marker does not exist' }
    throw error
  }
  const markerIdentity = statIdentity(markerStat)
  if (!markerStat.isDirectory()) {
    return { exists: true, identity: `marker:${markerIdentity}`, reason: 'ownership marker path is not a directory' }
  }
  try {
    const ownerPath = join(markerPath, OWNER_FILE)
    const ownerStat = await lstat(ownerPath)
    if (!ownerStat.isFile()) {
      return {
        exists: true,
        identity: `marker:${markerIdentity}:owner:${statIdentity(ownerStat)}`,
        reason: 'owner metadata path is not a regular file',
      }
    }
    const raw = await readFile(ownerPath, 'utf8')
    const identity = `marker:${markerIdentity}:owner:${statIdentity(ownerStat)}:raw:${createHash('sha256').update(raw).digest('hex')}`
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error) {
      if (error instanceof SyntaxError) return { exists: true, identity, reason: 'owner metadata is malformed' }
      throw error
    }
    if (!isOwner(value)) return { exists: true, identity, reason: 'owner metadata is invalid' }
    return { exists: true, identity, owner: value, reason: `owned by PID ${value.pid} on ${value.hostname}` }
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return { exists: true, identity: `marker:${markerIdentity}:owner:missing`, reason: 'owner metadata is missing' }
    }
    return {
      exists: true,
      identity: `marker:${markerIdentity}:owner:error:${errorCode(error)}`,
      reason: `owner metadata could not be read (${errorCode(error)})`,
    }
  }
}

function statIdentity(value: { dev: number | bigint; ino: number | bigint; mode: number; size: number | bigint; mtimeMs: number }): string {
  return `${value.dev}:${value.ino}:${value.mode}:${value.size}:${value.mtimeMs}`
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : 'unknown error'
}

function isOwner(value: unknown): value is DataRootOwner {
  if (!value || typeof value !== 'object') return false
  const owner = value as Partial<DataRootOwner>
  return owner.format === OWNER_FORMAT && Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 &&
    typeof owner.hostname === 'string' && owner.hostname.length > 0 &&
    typeof owner.startedAt === 'string' && !Number.isNaN(Date.parse(owner.startedAt)) &&
    typeof owner.instanceId === 'string' && owner.instanceId.length > 0 &&
    typeof owner.canonicalRoot === 'string' && owner.canonicalRoot.length > 0
}

async function ownershipTransitionArtifacts(markerPath: string): Promise<string[]> {
  const parent = dirname(markerPath)
  const prefix = `${basename(markerPath)}.`
  try {
    return (await readdir(parent))
      .filter((name) => name.startsWith(`${prefix}transition`) || name.startsWith(`${prefix}recovery-`) ||
        name.startsWith(`${prefix}released-`) || name.startsWith(`${prefix}recovered-`))
      .map((name) => join(parent, name))
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return []
    throw error
  }
}

async function hasOwnershipTransition(markerPath: string): Promise<boolean> {
  return (await ownershipTransitionArtifacts(markerPath)).length > 0
}

function hasCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code)
}

async function assertExternalMarker(canonicalRoot: string, markerPath: string): Promise<void> {
  const location = relative(canonicalRoot, await canonicalDataRoot(markerPath))
  if (location === '' || (!location.startsWith('..') && !isAbsolute(location))) {
    throw new DataRootOwnershipError(
      `Elves ownership marker ${markerPath} must be outside data root ${canonicalRoot}.`,
      canonicalRoot,
      markerPath,
    )
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
