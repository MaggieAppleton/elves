import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  DataRootOwnershipError,
  acquireDataRootOwnership,
  canonicalDataRoot,
  ownershipMarkerPath,
  recoverDataRootOwnership,
} from '../../server/dataRootOwnership'

const cleanups: string[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'elves-owner-test-'))
  cleanups.push(base)
  const dataRoot = join(base, 'data')
  const runtimeRoot = join(base, 'runtime')
  await mkdir(dataRoot)
  return { base, dataRoot, runtimeRoot }
}

test('canonical aliases derive one external marker and a second owner fails closed', async () => {
  const { base, dataRoot, runtimeRoot } = await fixture()
  const alias = join(base, 'data-alias')
  await symlink(dataRoot, alias)
  const canonical = await canonicalDataRoot(dataRoot)
  expect(await canonicalDataRoot(alias)).toBe(canonical)

  const first = await acquireDataRootOwnership(dataRoot, { runtimeRoot })
  expect(first.markerPath).toBe(ownershipMarkerPath(canonical, runtimeRoot))
  expect(first.markerPath.startsWith(`${await realpath(dataRoot)}/`)).toBe(false)
  await expect(acquireDataRootOwnership(alias, { runtimeRoot })).rejects.toMatchObject({
    name: 'DataRootOwnershipError',
    canonicalRoot: canonical,
    markerPath: first.markerPath,
  })
  await expect(readFile(join(first.markerPath, 'owner.json'), 'utf8')).resolves.toContain(`"pid":${process.pid}`)
  await first.release()
})

test('ownership refuses a runtime marker located inside the data root', async () => {
  const { dataRoot } = await fixture()
  await expect(acquireDataRootOwnership(dataRoot, { runtimeRoot: join(dataRoot, 'runtime') }))
    .rejects.toThrow(/must be outside data root/)
})

test('normal startup never reclaims stale, foreign, or malformed ownership', async () => {
  const cases = [
    { name: 'stale local', owner: { pid: 999_999_991, hostname: 'test-host', startedAt: '2026-09-05T09:00:00.000Z', instanceId: 'stale', format: 1 } },
    { name: 'foreign', owner: { pid: 42, hostname: 'elsewhere', startedAt: '2026-09-05T09:00:00.000Z', instanceId: 'foreign', format: 1 } },
    { name: 'malformed', raw: '{not-json' },
  ]
  for (const entry of cases) {
    const { dataRoot, runtimeRoot } = await fixture()
    const canonical = await canonicalDataRoot(dataRoot)
    const markerPath = ownershipMarkerPath(canonical, runtimeRoot)
    await mkdir(markerPath, { recursive: true })
    const raw = entry.raw ?? JSON.stringify({ ...entry.owner, canonicalRoot: canonical })
    await writeFile(join(markerPath, 'owner.json'), raw)

    await expect(acquireDataRootOwnership(dataRoot, {
      runtimeRoot,
      hostname: 'test-host',
      probePid: () => 'absent',
    })).rejects.toBeInstanceOf(DataRootOwnershipError)
    await expect(readFile(join(markerPath, 'owner.json'), 'utf8')).resolves.toBe(raw)
  }
})

test('release removes only the exact instance it acquired', async () => {
  const { dataRoot, runtimeRoot } = await fixture()
  const ownership = await acquireDataRootOwnership(dataRoot, { runtimeRoot, instanceId: 'owner-a' })
  const replacement = { ...ownership.owner, instanceId: 'owner-b' }
  await writeFile(join(ownership.markerPath, 'owner.json'), JSON.stringify(replacement))

  await expect(ownership.release()).resolves.toBe(false)
  await expect(readFile(join(ownership.markerPath, 'owner.json'), 'utf8')).resolves.toContain('owner-b')
})

test('recovery refuses live local ownership and requires force for stale or malformed state', async () => {
  const { dataRoot, runtimeRoot } = await fixture()
  const live = await acquireDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', pid: 4242, instanceId: 'live-owner',
  })
  await expect(recoverDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', force: true, probePid: () => 'live',
  })).rejects.toThrow(/still live/i)
  await expect(readFile(join(live.markerPath, 'owner.json'), 'utf8')).resolves.toContain('live-owner')

  await expect(recoverDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', force: false, probePid: () => 'absent',
  })).rejects.toThrow(/--force/)
  await expect(recoverDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', force: true, probePid: () => 'absent',
  })).resolves.toMatchObject({ recovered: true, markerPath: live.markerPath })
  await expect(acquireDataRootOwnership(dataRoot, { runtimeRoot })).resolves.toBeTruthy()
})

test('recovery refuses an ambiguous local PID and force-removes foreign or malformed state', async () => {
  const ambiguous = await fixture()
  const local = await acquireDataRootOwnership(ambiguous.dataRoot, {
    runtimeRoot: ambiguous.runtimeRoot, hostname: 'test-host', pid: 4242,
  })
  await expect(recoverDataRootOwnership(ambiguous.dataRoot, {
    runtimeRoot: ambiguous.runtimeRoot, hostname: 'test-host', force: true,
    probePid: () => 'ambiguous',
  })).rejects.toThrow(/conclusively/)
  await expect(readFile(join(local.markerPath, 'owner.json'), 'utf8')).resolves.toContain('4242')

  for (const rawOwner of [
    (canonicalRoot: string) => JSON.stringify({
      pid: 42, hostname: 'another-host', startedAt: '2026-09-05T09:00:00.000Z',
      instanceId: 'foreign', format: 1, canonicalRoot,
    }),
    () => '{broken-json',
  ]) {
    const { dataRoot, runtimeRoot } = await fixture()
    const canonicalRoot = await canonicalDataRoot(dataRoot)
    const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
    await mkdir(markerPath, { recursive: true })
    await writeFile(join(markerPath, 'owner.json'), rawOwner(canonicalRoot))
    await expect(recoverDataRootOwnership(dataRoot, { runtimeRoot, force: true, hostname: 'test-host' }))
      .resolves.toMatchObject({ recovered: true, markerPath })
  }
})

test('forced recovery refuses a marker whose metadata names another canonical root', async () => {
  const { base, dataRoot, runtimeRoot } = await fixture()
  const otherRoot = join(base, 'other-data')
  await mkdir(otherRoot)
  const canonicalRoot = await canonicalDataRoot(dataRoot)
  const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
  const raw = JSON.stringify({
    pid: 42,
    hostname: 'another-host',
    startedAt: '2026-09-05T09:00:00.000Z',
    instanceId: 'wrong-root',
    format: 1,
    canonicalRoot: await canonicalDataRoot(otherRoot),
  })
  await mkdir(markerPath, { recursive: true })
  await writeFile(join(markerPath, 'owner.json'), raw)

  await expect(recoverDataRootOwnership(dataRoot, { runtimeRoot, force: true }))
    .rejects.toThrow(/different canonical root/)
  await expect(readFile(join(markerPath, 'owner.json'), 'utf8')).resolves.toBe(raw)
})

test.each(['marker-file', 'owner-directory'])('malformed ownership node %s fails closed and forced recovery removes it', async (shape) => {
  const { dataRoot, runtimeRoot } = await fixture()
  const canonicalRoot = await canonicalDataRoot(dataRoot)
  const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
  await mkdir(runtimeRoot, { recursive: true })
  if (shape === 'marker-file') {
    await writeFile(markerPath, 'not a directory')
  } else {
    await mkdir(join(markerPath, 'owner.json'), { recursive: true })
  }

  await expect(acquireDataRootOwnership(dataRoot, { runtimeRoot })).rejects.toMatchObject({
    name: 'DataRootOwnershipError', markerPath,
  })
  await expect(recoverDataRootOwnership(dataRoot, { runtimeRoot, force: true }))
    .resolves.toMatchObject({ recovered: true, markerPath })
  const acquired = await acquireDataRootOwnership(dataRoot, { runtimeRoot })
  await expect(acquired.release()).resolves.toBe(true)
})

test('forced recovery clears guards stranded before and after marker quarantine', async () => {
  const first = await fixture()
  const stale = await acquireDataRootOwnership(first.dataRoot, {
    runtimeRoot: first.runtimeRoot, hostname: 'test-host', pid: 4242,
  })
  await mkdir(`${stale.markerPath}.transition`)
  await expect(recoverDataRootOwnership(first.dataRoot, {
    runtimeRoot: first.runtimeRoot, hostname: 'test-host', probePid: () => 'absent', force: false,
  })).rejects.toThrow(/--force/)
  await expect(recoverDataRootOwnership(first.dataRoot, {
    runtimeRoot: first.runtimeRoot, hostname: 'test-host', probePid: () => 'absent', force: true,
  })).resolves.toMatchObject({ recovered: true })
  const reacquired = await acquireDataRootOwnership(first.dataRoot, { runtimeRoot: first.runtimeRoot })
  await reacquired.release()

  const second = await fixture()
  const interrupted = await acquireDataRootOwnership(second.dataRoot, {
    runtimeRoot: second.runtimeRoot, hostname: 'test-host', pid: 4243,
  })
  await mkdir(`${interrupted.markerPath}.transition`)
  await rename(interrupted.markerPath, `${interrupted.markerPath}.released-interrupted`)
  await expect(acquireDataRootOwnership(second.dataRoot, { runtimeRoot: second.runtimeRoot }))
    .rejects.toThrow(/recovery or shutdown is still in progress/)
  await expect(recoverDataRootOwnership(second.dataRoot, {
    runtimeRoot: second.runtimeRoot, hostname: 'test-host', force: true,
  })).resolves.toMatchObject({ recovered: true })
  const afterQuarantine = await acquireDataRootOwnership(second.dataRoot, { runtimeRoot: second.runtimeRoot })
  await afterQuarantine.release()
})

test('forced recovery never removes a live owner behind a transition guard', async () => {
  const { dataRoot, runtimeRoot } = await fixture()
  const live = await acquireDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', pid: 4242,
  })
  await mkdir(`${live.markerPath}.transition`)
  await expect(recoverDataRootOwnership(dataRoot, {
    runtimeRoot, hostname: 'test-host', force: true, probePid: () => 'live',
  })).rejects.toThrow(/still live/)
  await rm(`${live.markerPath}.transition`, { recursive: true })
  await live.release()
})

test('recovery instructions shell-quote command substitution and single quotes', async () => {
  const { base, runtimeRoot } = await fixture()
  const unsafeRoot = join(base, "data-$(touch nope)-`touch nope`-'quoted")
  await mkdir(unsafeRoot)
  const owner = await acquireDataRootOwnership(unsafeRoot, { runtimeRoot })
  const error = await acquireDataRootOwnership(unsafeRoot, { runtimeRoot }).catch((value: unknown) => value)
  expect(error).toBeInstanceOf(DataRootOwnershipError)
  expect((error as Error).message).toContain("--data-root '")
  expect((error as Error).message).toContain("'\"'\"'quoted'")
  await owner.release()
})
