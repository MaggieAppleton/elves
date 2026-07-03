import { afterEach, expect, test, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { createServer } from '../../server/app'
import type { PresenceMessage } from '../../src/model/presence'

let dirs: string[] = []
async function appWithSpy() {
  const d = await fs.mkdtemp(join(tmpdir(), 'elves-presence-'))
  dirs.push(d)
  const onPresence = vi.fn<(projectId: string, presence: PresenceMessage) => void>()
  const app = createServer(d, undefined, undefined, onPresence)
  return { app, onPresence }
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
  dirs = []
})

test('reading specific cards emits a "looking" presence signal', async () => {
  const { app, onPresence } = await appWithSpy()
  await request(app).post('/projects').send({ name: 'Essay' })
  const res = await request(app).post('/projects/essay/cards').send({ ids: ['card:a', 'card:b'] })
  expect(res.status).toBe(200)
  expect(onPresence).toHaveBeenCalledTimes(1)
  expect(onPresence).toHaveBeenCalledWith('essay', { cardIds: ['card:a', 'card:b'], mode: 'looking' })
})

test('reading the map (whole-board scan) emits no presence', async () => {
  const { app, onPresence } = await appWithSpy()
  await request(app).post('/projects').send({ name: 'Essay' })
  await request(app).get('/projects/essay/map')
  expect(onPresence).not.toHaveBeenCalled()
})

test('an empty id list emits nothing', async () => {
  const { app, onPresence } = await appWithSpy()
  await request(app).post('/projects').send({ name: 'Essay' })
  await request(app).post('/projects/essay/cards').send({ ids: [] })
  expect(onPresence).not.toHaveBeenCalled()
})

test('reading cards of an unknown project (404) emits nothing', async () => {
  const { app, onPresence } = await appWithSpy()
  const res = await request(app).post('/projects/ghost/cards').send({ ids: ['card:a'] })
  expect(res.status).toBe(404)
  expect(onPresence).not.toHaveBeenCalled()
})
