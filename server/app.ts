import express, { Request, Response } from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'
import {
  isChangeSet,
  ChangeSet,
  changeSetWritesText,
  referencedCardIds,
} from '../src/model/changeset'
import { snapshotToCards } from './digest'
import { extForMime, saveAsset, resolveAssetPath } from './assets'
import {
  listProjects,
  createProject,
  renameProject,
  getProject,
  canvasPathFor,
  assetsDirFor,
  ProjectError,
} from './projects'

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

export function createServer(
  dataRoot: string,
  onChangeSet?: (projectId: string, cs: ChangeSet) => void,
) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '64mb' }))

  // Resolve a project's on-disk paths, or send 404 and return null.
  async function requireProject(
    id: string,
    res: Response,
  ): Promise<{ canvasPath: string; assetsDir: string } | null> {
    const canvasPath = canvasPathFor(dataRoot, id)
    const assetsDir = assetsDirFor(dataRoot, id)
    if (!canvasPath || !assetsDir || !(await getProject(dataRoot, id))) {
      res.status(404).json({ error: 'unknown project' })
      return null
    }
    return { canvasPath, assetsDir }
  }

  // --- Project management ---------------------------------------------------

  app.get(
    '/projects',
    wrap(async (_req, res) => {
      res.json(await listProjects(dataRoot))
    }),
  )

  app.post(
    '/projects',
    wrap(async (req, res) => {
      const name = req.body?.name
      if (typeof name !== 'string') {
        res.status(400).json({ error: 'name required' })
        return
      }
      try {
        res.json(await createProject(dataRoot, name, new Date().toISOString()))
      } catch (e) {
        if (e instanceof ProjectError) res.status(e.status).json({ error: e.message })
        else throw e
      }
    }),
  )

  app.patch(
    '/projects/:id',
    wrap(async (req, res) => {
      const name = req.body?.name
      if (typeof name !== 'string') {
        res.status(400).json({ error: 'name required' })
        return
      }
      try {
        res.json(await renameProject(dataRoot, req.params.id, name))
      } catch (e) {
        if (e instanceof ProjectError) res.status(e.status).json({ error: e.message })
        else throw e
      }
    }),
  )

  // --- Per-project canvas ---------------------------------------------------

  app.get(
    '/projects/:id/canvas',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json(await readCanvas(paths.canvasPath))
    }),
  )

  app.post(
    '/projects/:id/canvas',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const body = req.body
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        res.status(400).json({ error: 'canvas must be a JSON object' })
        return
      }
      await writeCanvas(paths.canvasPath, body as CanvasSnapshot)
      res.json({ ok: true })
    }),
  )

  app.get(
    '/projects/:id/cards',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json(snapshotToCards(await readCanvas(paths.canvasPath), paths.assetsDir))
    }),
  )

  app.post(
    '/projects/:id/changeset',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      if (!isChangeSet(req.body)) {
        res.status(400).json({ error: 'invalid change-set' })
        return
      }
      if (changeSetWritesText(req.body)) {
        res.status(403).json({ error: 'change-set may not write card text' })
        return
      }
      // Cross-check: every referenced existing card must live in THIS project, so a
      // mistargeted operation fails loudly instead of silently landing nowhere.
      const cardIds = new Set(snapshotToCards(await readCanvas(paths.canvasPath)).map((c) => c.id))
      const missing = referencedCardIds(req.body).filter((cardId) => !cardIds.has(cardId))
      if (missing.length) {
        res.status(409).json({ error: 'card not in project', missing })
        return
      }
      onChangeSet?.(req.params.id, req.body)
      res.json({ ok: true })
    }),
  )

  // --- Per-project assets ---------------------------------------------------

  app.post(
    '/projects/:id/assets',
    express.raw({ type: ['image/*'], limit: '25mb' }),
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const ext = extForMime((req.headers['content-type'] ?? '').split(';')[0].trim())
      if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ error: 'expected a non-empty image body' })
        return
      }
      const assetId = await saveAsset(paths.assetsDir, req.body, ext)
      res.json({ assetId })
    }),
  )

  app.get(
    '/projects/:id/assets/:assetId',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const path = resolveAssetPath(paths.assetsDir, req.params.assetId)
      if (!path) {
        res.status(400).json({ error: 'bad asset id' })
        return
      }
      res.sendFile(path, (err) => {
        if (err && !res.headersSent) res.status(404).end()
      })
    }),
  )

  return app
}
