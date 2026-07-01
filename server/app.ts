import express from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'
import { isChangeSet, ChangeSet } from '../src/model/changeset'

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

  app.post('/changeset', (req, res) => {
    if (!isChangeSet(req.body)) {
      res.status(400).json({ error: 'invalid change-set' })
      return
    }
    onChangeSet?.(req.body)
    res.json({ ok: true })
  })

  return app
}
