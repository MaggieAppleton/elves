import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import WebSocket from 'ws'
import {
  canonicalDataRoot,
  ownershipMarkerPath,
  recoverDataRootOwnership,
} from '../../server/dataRootOwnership'

const children = new Set<ChildProcess>()
const cleanups: string[] = []

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  children.clear()
  await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

test('a second server through a symlink fails before mutation while the owner keeps serving', async () => {
  const { base, dataRoot, runtimeRoot } = await fixture()
  const alias = join(base, 'data-alias')
  await symlink(dataRoot, alias)
  const serverA = await startServer(dataRoot, runtimeRoot)

  const createdResponse = await fetch(`${serverA.url}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ownership test' }),
  })
  expect(createdResponse.status).toBe(200)
  const created = (await createdResponse.json()) as { id: string }
  const beforeSecondStart = await snapshotTree(dataRoot)

  const serverB = await runServerToExit(alias, runtimeRoot)
  expect(serverB.code).not.toBe(0)
  expect(serverB.stderr).toContain(await canonicalDataRoot(dataRoot))
  expect(serverB.stderr).toContain(`PID ${serverA.child.pid}`)
  expect(await snapshotTree(dataRoot)).toEqual(beforeSecondStart)

  const loadedResponse = await fetch(`${serverA.url}/projects/${created.id}/canvas?protocol=2`)
  expect(loadedResponse.status).toBe(200)
  const loaded = (await loadedResponse.json()) as { snapshot: unknown; revision: number }
  const save = (writer: string) => fetch(`${serverA.url}/projects/${created.id}/canvas?protocol=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-elves-canvas-revision': String(loaded.revision) },
    body: JSON.stringify({ ...(loaded.snapshot as object), session: { writer } }),
  })
  const competingSaves = await Promise.all([save('a'), save('b')])
  expect(competingSaves.map((response) => response.status).sort()).toEqual([200, 409])

  const socket = new WebSocket(`${serverA.url.replace('http:', 'ws:')}/ws`)
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })
  serverA.child.kill('SIGTERM')
  await waitForExit(serverA.child)
  await expect(readFile(join(await markerFor(dataRoot, runtimeRoot), 'owner.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

test('a server keeps using the canonical root after its launch symlink is retargeted', async () => {
  const { base, runtimeRoot } = await fixture()
  const rootA = join(base, 'root-a')
  const rootB = join(base, 'root-b')
  const alias = join(base, 'current-data')
  await mkdir(rootA)
  await mkdir(rootB)
  await symlink(rootA, alias)
  const serverA = await startServer(alias, runtimeRoot)

  await unlink(alias)
  await symlink(rootB, alias)
  const created = await fetch(`${serverA.url}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Still root A' }),
  })
  expect(created.status).toBe(200)
  expect((await snapshotTree(rootA)).length).toBeGreaterThan(0)
  expect(await snapshotTree(rootB)).toEqual([])

  const serverB = await startServer(alias, runtimeRoot)
  const projectsA = await fetch(`${serverA.url}/projects`).then((response) => response.json()) as unknown[]
  const projectsB = await fetch(`${serverB.url}/projects`).then((response) => response.json()) as unknown[]
  expect(projectsA).toHaveLength(1)
  expect(projectsB).toEqual([])

  serverA.child.kill('SIGTERM')
  serverB.child.kill('SIGTERM')
  await Promise.all([waitForExit(serverA.child), waitForExit(serverB.child)])
})

test('SIGTERM during bootstrap releases ownership before any server becomes ready', async () => {
  const { dataRoot, runtimeRoot } = await fixture()
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELVES_DATA: dataRoot,
      ELVES_TEST_OWNERSHIP_RUNTIME: runtimeRoot,
      ELVES_TEST_BOOTSTRAP_PAUSE_MS: '5000',
      ELVES_HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  const markerPath = await markerFor(dataRoot, runtimeRoot)
  await waitUntilAsync(async () => {
    try {
      await readFile(join(markerPath, 'owner.json'))
      return true
    } catch {
      return false
    }
  })
  const beforeSignal = await snapshotTree(dataRoot)
  child.kill('SIGTERM')
  await waitForExit(child)
  await expect(readFile(join(markerPath, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await snapshotTree(dataRoot)).toEqual(beforeSignal)
})

test('SIGTERM waits for an active agent child to stop before releasing ownership', async () => {
  const { base, dataRoot, runtimeRoot } = await fixture()
  const cli = join(base, 'agent-stub.sh')
  const started = join(base, 'agent-started')
  const stopped = join(base, 'agent-stopped')
  await writeFile(cli, `#!/bin/sh\ntrap 'printf stopped > "${stopped}"; exit 0' TERM\nprintf started > "${started}"\nwhile :; do sleep 1; done\n`)
  await chmod(cli, 0o700)
  const server = await startServer(dataRoot, runtimeRoot, { ELVES_CLI_BIN: cli })
  const projectResponse = await fetch(`${server.url}/projects`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent shutdown' }),
  })
  const project = await projectResponse.json() as { id: string }
  const runId = 'shutdown-run'
  const prepare = await fetch(`${server.url}/agent/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: project.id, runId }),
  })
  expect(prepare.status).toBe(200)
  const running = await fetch(`${server.url}/agent/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, runId, prompt: 'wait', hasSelection: false }),
  })
  expect(running.status).toBe(200)
  await waitUntilAsync(async () => readFile(started).then(() => true, () => false))

  server.child.kill('SIGTERM')
  await waitForExit(server.child)
  await expect(readFile(stopped, 'utf8')).resolves.toBe('stopped')
  await expect(readFile(join(await markerFor(dataRoot, runtimeRoot), 'owner.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

test('SIGKILL leaves a marker that startup will not steal and explicit forced recovery removes', async () => {
  const { dataRoot, runtimeRoot } = await fixture()
  const serverA = await startServer(dataRoot, runtimeRoot)
  const markerPath = await markerFor(dataRoot, runtimeRoot)
  const ownerBefore = await readFile(join(markerPath, 'owner.json'), 'utf8')

  serverA.child.kill('SIGKILL')
  await waitForExit(serverA.child)
  const serverB = await runServerToExit(dataRoot, runtimeRoot)
  expect(serverB.code).not.toBe(0)
  expect(serverB.stderr).toContain('normal startup will not reclaim it')
  expect(await readFile(join(markerPath, 'owner.json'), 'utf8')).toBe(ownerBefore)

  await expect(recoverDataRootOwnership(dataRoot, { runtimeRoot, force: false }))
    .rejects.toThrow(/--force/)
  await expect(recoverDataRootOwnership(dataRoot, { runtimeRoot, force: true }))
    .resolves.toMatchObject({ recovered: true, markerPath })
})

test.each([
  ['foreign-host metadata', (canonicalRoot: string) => JSON.stringify({
    pid: 42,
    hostname: 'another-host',
    startedAt: '2026-09-05T09:00:00.000Z',
    instanceId: 'foreign-owner',
    format: 1,
    canonicalRoot,
  })],
  ['malformed metadata', () => '{not-json'],
])('precreated %s blocks server bootstrap without changing the marker', async (_label, ownerJson) => {
  const { dataRoot, runtimeRoot } = await fixture()
  const canonicalRoot = await canonicalDataRoot(dataRoot)
  const markerPath = ownershipMarkerPath(canonicalRoot, runtimeRoot)
  await mkdir(markerPath, { recursive: true })
  const raw = ownerJson(canonicalRoot)
  await writeFile(join(markerPath, 'owner.json'), raw)
  const beforeStart = await snapshotTree(dataRoot)

  const server = await runServerToExit(dataRoot, runtimeRoot)
  expect(server.code).not.toBe(0)
  expect(server.stderr).toContain(markerPath)
  expect(await readFile(join(markerPath, 'owner.json'), 'utf8')).toBe(raw)
  expect(await snapshotTree(dataRoot)).toEqual(beforeStart)
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'elves-owner-process-'))
  cleanups.push(base)
  const dataRoot = join(base, 'data')
  const runtimeRoot = join(base, 'runtime')
  await mkdir(dataRoot)
  return { base, dataRoot, runtimeRoot }
}

async function startServer(dataRoot: string, runtimeRoot: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELVES_DATA: dataRoot,
      ELVES_TEST_OWNERSHIP_RUNTIME: runtimeRoot,
      ELVES_HOST: '127.0.0.1',
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  await waitUntil(() => stdout.includes('Elves server on'), () => {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`)
  })
  return { child, url: `http://127.0.0.1:${port}` }
}

async function runServerToExit(dataRoot: string, runtimeRoot: string) {
  const port = await freePort()
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      ELVES_DATA: dataRoot,
      ELVES_TEST_OWNERSHIP_RUNTIME: runtimeRoot,
      ELVES_HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.add(child)
  let stdout = ''
  let stderr = ''
  child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  const code = await waitForExit(child)
  return { code, stdout, stderr }
}

async function markerFor(dataRoot: string, runtimeRoot: string) {
  return ownershipMarkerPath(await canonicalDataRoot(dataRoot), runtimeRoot)
}

async function snapshotTree(root: string): Promise<Array<[string, string]>> {
  const files: Array<[string, string]> = []
  const walk = async (directory: string, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = join(prefix, entry.name)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path, relative)
      else files.push([relative, (await readFile(path)).toString('base64')])
    }
  }
  await walk(root)
  return files
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('failed to allocate a test port')
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  return address.port
}

async function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error('server process did not exit')), 10_000)
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolveExit(code)
    })
  })
}

async function waitUntil(check: () => boolean, inspect: () => void): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    inspect()
    if (Date.now() > deadline) throw new Error('server did not become ready')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
}

async function waitUntilAsync(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition did not become true')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
}
