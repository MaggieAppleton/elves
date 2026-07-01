import express, { Request, Response } from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'
import { isChangeSet, ChangeSet, changeSetWritesText } from '../src/model/changeset'
import { snapshotToCards } from './digest'
import { assetsDir, extForMime, saveAsset, resolveAssetPath } from './assets'

// Express 4 does not await async handlers, so a rejected promise becomes a fatal
// unhandled rejection that takes down the whole server. wrap() turns any handler
// error into a 500 for that one request, keeping every other client connected.
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      console.error('[elves] request handler failed:', err)
      if (!res.headersSent) res.status(500).json({ error: 'internal error' })
    })
  }
}

export function createServer(dataPath: string, onChangeSet?: (cs: ChangeSet) => void) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '64mb' }))

  app.get(
    '/canvas',
    wrap(async (_req, res) => {
      res.json(await readCanvas(dataPath))
    }),
  )

  app.post(
    '/canvas',
    wrap(async (req, res) => {
      const body = req.body
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({ error: 'canvas must be a JSON object' })
        return
      }
      await writeCanvas(dataPath, body as CanvasSnapshot)
      res.json({ ok: true })
    }),
  )

  app.get(
    '/cards',
    wrap(async (_req, res) => {
      res.json(snapshotToCards(await readCanvas(dataPath)))
    }),
  )

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

  app.post('/assets', express.raw({ type: ['image/*'], limit: '25mb' }), async (req, res) => {
    const ext = extForMime((req.headers['content-type'] ?? '').split(';')[0].trim())
    if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'expected a non-empty image body' })
      return
    }
    const assetId = await saveAsset(assetsDir(dataPath), req.body, ext)
    res.json({ assetId })
  })

  app.get('/assets/:id', (req, res) => {
    const path = resolveAssetPath(assetsDir(dataPath), req.params.id)
    if (!path) {
      res.status(400).json({ error: 'bad asset id' })
      return
    }
    res.sendFile(path, (err) => {
      if (err && !res.headersSent) res.status(404).end()
    })
  })

  return app
}
