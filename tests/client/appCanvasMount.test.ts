import { describe, expect, test, vi } from 'vitest'
import type { Project } from '../../src/client/persistence'
import type { CanvasWriteCoordinator } from '../../src/client/canvasWriteCoordinator'
import { CanvasRenameCommittedDrainError } from '../../src/client/canvasRenameCoordinator'
import {
  canvasWriteStatusLabel,
  committedRenameProject,
  createAppCanvasMount,
  flushCanvasMountForSwitch,
  requestOwnedRemoteSync,
} from '../../src/client/appCanvasMount'

const project: Project = { id: 'draft', name: 'Draft', createdAt: 'now' }

function coordinator(overrides: Partial<CanvasWriteCoordinator> = {}): CanvasWriteCoordinator {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    markDirty: vi.fn(),
    requestRemoteSync: vi.fn().mockResolvedValue(undefined),
    flushOrThrow: vi.fn().mockResolvedValue(undefined),
    renameProject: vi.fn(),
    ownsProject: vi.fn((id) => id === project.id),
    dispose: vi.fn(),
    ...overrides,
  }
}

test('installs the user document listener only after initialization', async () => {
  let resolveInitialize!: () => void
  const initialized = new Promise<void>((resolve) => {
    resolveInitialize = resolve
  })
  const writeCoordinator = coordinator({ initialize: vi.fn(() => initialized) })
  const listen = vi.fn(() => vi.fn())
  const mount = createAppCanvasMount({ project, editor: {} as never, writeCoordinator, listen })

  const pending = mount.initialize()
  expect(listen).not.toHaveBeenCalled()
  resolveInitialize()
  await expect(pending).resolves.toBe(true)
  expect(listen).toHaveBeenCalledWith(writeCoordinator.markDirty)
})

test('coalesces concurrent initialization without duplicate listeners', async () => {
  let resolveInitialize!: () => void
  const initialized = new Promise<void>((resolve) => {
    resolveInitialize = resolve
  })
  const writeCoordinator = coordinator({ initialize: vi.fn(() => initialized) })
  const listen = vi.fn(() => vi.fn())
  const mount = createAppCanvasMount({ project, editor: {} as never, writeCoordinator, listen })

  const first = mount.initialize()
  const second = mount.initialize()
  resolveInitialize()

  await Promise.all([first, second])
  expect(writeCoordinator.initialize).toHaveBeenCalledOnce()
  expect(listen).toHaveBeenCalledOnce()
})

test('dispose tears down the listener and coordinator and blocks late initialization', async () => {
  let resolveInitialize!: () => void
  const initialized = new Promise<void>((resolve) => {
    resolveInitialize = resolve
  })
  const stop = vi.fn()
  const listen = vi.fn(() => stop)
  const writeCoordinator = coordinator({ initialize: vi.fn(() => initialized) })
  const mount = createAppCanvasMount({ project, editor: {} as never, writeCoordinator, listen })

  const pending = mount.initialize()
  mount.dispose()
  resolveInitialize()

  await expect(pending).resolves.toBe(false)
  expect(listen).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
  expect(writeCoordinator.dispose).toHaveBeenCalledOnce()
})

test('restarts selection by stopping the old reporter before starting the new identity', () => {
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator: coordinator(),
    listen: vi.fn(),
  })
  const calls: string[] = []
  mount.restartSelection(() => {
    calls.push('start-old')
    return () => calls.push('stop-old')
  })
  mount.restartSelection(() => {
    calls.push('start-new')
    return vi.fn()
  })
  expect(calls).toEqual(['start-old', 'stop-old', 'start-new'])
})

test('routes realtime sync only to a coordinator that owns the project', async () => {
  const writeCoordinator = coordinator()
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator,
    listen: vi.fn(),
  })

  await expect(requestOwnedRemoteSync(mount, 'other', true)).resolves.toBe(false)
  expect(writeCoordinator.requestRemoteSync).not.toHaveBeenCalled()
  await expect(requestOwnedRemoteSync(mount, 'draft', true)).resolves.toBe(true)
  expect(writeCoordinator.requestRemoteSync).toHaveBeenCalledWith({ glow: true })
})

test('same-tick switch admission marks dirty before flushing', async () => {
  const calls: string[] = []
  const writeCoordinator = coordinator({
    markDirty: vi.fn(() => calls.push('dirty')),
    flushOrThrow: vi.fn(async () => { calls.push('flush') }),
  })
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator,
    listen: vi.fn(),
  })

  await flushCanvasMountForSwitch(mount)
  expect(calls).toEqual(['dirty', 'flush'])
})

test('switch flush waits for mount-owned async commands', async () => {
  let finishCommand!: () => void
  const command = new Promise<void>((resolve) => {
    finishCommand = resolve
  })
  const writeCoordinator = coordinator()
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator,
    listen: vi.fn(),
  })
  const running = mount.runCommand(async ({ assertCurrent }) => {
    await command
    assertCurrent()
  })

  const flushing = flushCanvasMountForSwitch(mount)
  await expect(mount.runCommand(async () => undefined)).rejects.toMatchObject({
    name: 'AppCanvasCommandAdmissionClosedError',
  })
  expect(writeCoordinator.flushOrThrow).not.toHaveBeenCalled()
  finishCommand()
  await running
  await flushing
  expect(writeCoordinator.flushOrThrow).toHaveBeenCalledOnce()
})

test('a command checks ownership before issuing its first async request', async () => {
  const writeCoordinator = coordinator({ ownsProject: vi.fn(() => false) })
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator,
    listen: vi.fn(),
  })
  const issueRequest = vi.fn()

  await expect(mount.runCommand(async () => { issueRequest() })).rejects.toMatchObject({
    name: 'AppCanvasMountStaleError',
  })
  expect(issueRequest).not.toHaveBeenCalled()
})

test('an async command cannot apply after its mount is disposed', async () => {
  let finishCommand!: () => void
  const command = new Promise<void>((resolve) => {
    finishCommand = resolve
  })
  const mount = createAppCanvasMount({
    project,
    editor: {} as never,
    writeCoordinator: coordinator(),
    listen: vi.fn(),
  })
  const apply = vi.fn()
  const running = mount.runCommand(async ({ assertCurrent }) => {
    await command
    assertCurrent()
    apply()
  })

  mount.dispose()
  finishCommand()
  await expect(running).rejects.toMatchObject({ name: 'AppCanvasMountStaleError' })
  expect(apply).not.toHaveBeenCalled()
})

test('extracts committed rename identity from a drain error', () => {
  const renamed = { ...project, id: 'final', name: 'Final' }
  const error = new CanvasRenameCommittedDrainError(renamed, new Error('drain failed'))
  expect(committedRenameProject(error)).toEqual(renamed)
  expect(committedRenameProject(new Error('rename failed'))).toBeNull()
})

describe('canvas write status labels', () => {
  test.each([
    ['loading', 'Loading canvas'],
    ['idle', 'Canvas saved'],
    ['unsaved', 'Canvas has unsaved changes'],
    ['saving', 'Saving canvas'],
    ['syncing', 'Syncing canvas'],
    ['renaming', 'Renaming project'],
    ['conflict', 'Canvas has a save conflict'],
    ['rename-ambiguous', 'Project rename needs attention'],
    ['error', 'Canvas save failed'],
  ] as const)('%s is explicit', (status, label) => {
    expect(canvasWriteStatusLabel(status)).toBe(label)
  })
})
