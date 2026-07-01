import express from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'
import { isChangeSet, ChangeSet, changeSetWritesText } from '../src/model/changeset'
import { snapshotToCards } from './digest'

export function createServer(dataPath: string, onChangeSet?: (cs: ChangeSet) => void) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '64mb' }))

  app.get('/canvas', async (_req, res) => {
    res.json(await readCanvas(dataPath))
  })

  app.post('/canvas', async (req, res) => {
    const body = req.body
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      res.status(400).json({ error: 'canvas must be a JSON object' })
      return
    }
    await writeCanvas(dataPath, body as CanvasSnapshot)
    res.json({ ok: true })
  })

  app.get('/cards', async (_req, res) => {
    res.json(snapshotToCards(await readCanvas(dataPath)))
  })

  app.post('/changeset', (req, res) => {
    if (!isChangeSet(req.body)) {
      res.status(400).json({ error: 'invalid change-set' })
      return
    }
    if (changeSetWritesText(req.body)) {
      res.status(403).json({ error: 'change-set may not write card text' })
      return
    }
    onChangeSet?.(req.body)
    res.json({ ok: true })
  })

  return app
}
