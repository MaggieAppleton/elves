import express, { Request, Response } from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, CanvasSnapshot } from './store'
import {
  isChangeSet,
  ChangeSet,
  changeSetWritesText,
  referencedCardIds,
  referencedSectionIds,
} from '../src/model/changeset'
import { snapshotToCards, snapshotToSections, snapshotToCanvasDigest } from './digest'
import { applyChangeSetToSnapshot } from './applyChangeSet'
import { extForMime, saveAsset, resolveAssetPath } from './assets'
import { unfurl, type UnfurlDeps, type FetchedImage } from './unfurl'
import {
  listProjects,
  createProject,
  renameProject,
  getProject,
  canvasPathFor,
  assetsDirFor,
  ProjectError,
} from './projects'

const UNFURL_UA = 'ElvesBot/0.1 (+local-first writing studio; reference unfurl)'
const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 2_000_000
const MAX_IMAGE_BYTES = 5_000_000

// Real network + asset I/O for unfurl, scoped to one project's assets dir. The
// fetches are http(s)-only, time-limited, and size-capped; images are stored as
// local files so a reference card stays offline-usable and portable.
function unfurlDepsFor(assetsDir: string): UnfurlDeps {
  const withTimeout = async (url: string, accept: string) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': UNFURL_UA, accept },
      })
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    fetchText: async (url) => {
      const res = await withTimeout(url, 'text/html,application/xhtml+xml')
      const ct = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!res.ok || !ct.includes('html')) throw new Error(`not html (${res.status})`)
      const html = (await res.text()).slice(0, MAX_HTML_BYTES)
      return { html, finalUrl: res.url || url }
    },
    fetchImage: async (url): Promise<FetchedImage | null> => {
      const res = await withTimeout(url, 'image/*')
      if (!res.ok) return null
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!contentType.startsWith('image/')) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null
      return { bytes, contentType }
    },
    saveImage: async (img) => {
      const ext = extForMime(img.contentType)
      return ext ? saveAsset(assetsDir, img.bytes, ext) : null
    },
    now: () => new Date().toISOString(),
  }
}

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
    '/projects/:id/canvas-digest',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json(snapshotToCanvasDigest(await readCanvas(paths.canvasPath), paths.assetsDir))
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
      const canvas = await readCanvas(paths.canvasPath)
      // Cross-check: every referenced existing card/section must live in THIS
      // project, so a mistargeted operation fails loudly instead of silently
      // landing nowhere.
      const cardIds = new Set(snapshotToCards(canvas).map((c) => c.id))
      const sectionIds = new Set(snapshotToSections(canvas).map((s) => s.id))
      const missing = [
        ...referencedCardIds(req.body).filter((cardId) => !cardIds.has(cardId)),
        ...referencedSectionIds(req.body).filter((sectionId) => !sectionIds.has(sectionId)),
      ]
      if (missing.length) {
        res.status(409).json({ error: 'card not in project', missing })
        return
      }
      // Apply and persist here, on the server, rather than relying on some
      // connected browser tab to have this project open and save it back —
      // that dependency meant a change-set could report success while never
      // landing on disk. A brand-new project with no canvas yet has no
      // tldraw schema to write into, so it still falls back to broadcast-only
      // until a browser bootstraps the document for the first time.
      const applied = applyChangeSetToSnapshot(canvas, req.body)
      if (applied) await writeCanvas(paths.canvasPath, applied)
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

  // --- Reference unfurl -----------------------------------------------------
  // Given a URL, fetch it and return a structured Reference draft (title,
  // authors, favicon + hero cached as local assets). This makes an OUTBOUND
  // request to the URL the user pasted / asked Claude to enrich — always an
  // explicit, per-action fetch, never background. The canvas itself stays local.
  app.post(
    '/projects/:id/unfurl',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const url = req.body?.url
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        res.status(400).json({ error: 'a valid http(s) url is required' })
        return
      }
      const reference = await unfurl(url, unfurlDepsFor(paths.assetsDir))
      res.json({ reference })
    }),
  )

  return app
}
