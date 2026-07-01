import express from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'

export function createServer(dataPath: string) {
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

  return app
}
