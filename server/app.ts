import express, { Request, Response } from 'express'
import cors from 'cors'
import { readCanvas, writeCanvas, clearCanvas, EmptyCanvasOverwriteError, CanvasSnapshot } from './store'
import {
  isChangeSet,
  ChangeSet,
  changeSetWritesText,
  referencedCardIds,
  referencedSectionIds,
} from '../src/model/changeset'
import type { PresenceMessage } from '../src/model/presence'
import {
  snapshotToCards, snapshotToSections, snapshotToCardMap, snapshotToCardsById, snapshotToDraft,
} from './digest'
import { applyChangeSetToSnapshot } from './applyChangeSet'
import { reconcileCanvasFile, type Summarizer } from './summarize'
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

/**
 * Server-side summary generation. Provided only in production (server/index.ts);
 * tests and existing callers omit it, so the feature is dormant and every suite
 * stays hermetic. When present, card-text saves trigger a debounced, single-
 * flight reconcile per project that broadcasts model-authored summaries.
 */
export interface SummarizeConfig {
  summarizer: Summarizer
  now?: () => string
  debounceMs?: number
}

export function createServer(
  dataRoot: string,
  onChangeSet?: (projectId: string, cs: ChangeSet) => void,
  summarize?: SummarizeConfig,
  onPresence?: (projectId: string, presence: PresenceMessage) => void,
) {
  const app = express()
  app.use(cors())
  app.use(express.json({ limit: '64mb' }))

  // --- Summary reconciliation scheduler -------------------------------------
  // Debounce rapid saves per project, and never run two reconciles for the same
  // project at once (a save during a run re-marks it dirty and re-runs after).
  const now = summarize?.now ?? (() => new Date().toISOString())
  const debounceMs = summarize?.debounceMs ?? 1500
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const dirty = new Set<string>()

  async function runSummaries(projectId: string): Promise<void> {
    if (!summarize) return
    if (running.has(projectId)) {
      dirty.add(projectId)
      return
    }
    running.add(projectId)
    try {
      const canvasPath = canvasPathFor(dataRoot, projectId)
      if (canvasPath && (await getProject(dataRoot, projectId))) {
        const cs = await reconcileCanvasFile(canvasPath, summarize.summarizer, now)
        if (cs) onChangeSet?.(projectId, cs)
      }
    } catch (err) {
      console.error('[elves] summary reconcile failed:', err)
    } finally {
      running.delete(projectId)
      if (dirty.delete(projectId)) void runSummaries(projectId)
    }
  }

  function scheduleSummaries(projectId: string): void {
    if (!summarize) return
    const existing = pendingTimers.get(projectId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      pendingTimers.delete(projectId)
      void runSummaries(projectId)
    }, debounceMs)
    // Don't let a pending summary timer keep the process (or a test) alive.
    timer.unref?.()
    pendingTimers.set(projectId, timer)
  }

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
      try {
        await writeCanvas(paths.canvasPath, body as CanvasSnapshot)
      } catch (err) {
        // A save that would blank a canvas holding a real document is refused,
        // never a silent data loss. To clear a canvas on purpose, use DELETE.
        if (err instanceof EmptyCanvasOverwriteError) {
          res.status(409).json({ error: 'refusing to blank a non-empty canvas; use DELETE to clear' })
          return
        }
        throw err
      }
      // A canvas save is where user text edits land — reconcile summaries after.
      scheduleSummaries(req.params.id)
      res.json({ ok: true })
    }),
  )

  // Explicitly clear a canvas back to empty (distinct from a save, which may
  // never blank a real document). The current document is preserved as a .bak.
  app.delete(
    '/projects/:id/canvas',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      await clearCanvas(paths.canvasPath)
      res.json({ ok: true })
    }),
  )

  // The cheap navigation map: sections + a small entry per card (gist, position,
  // textLen), no full text. Claude reads this first, then drills into specific
  // cards with POST /cards.
  app.get(
    '/projects/:id/map',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json(snapshotToCardMap(await readCanvas(paths.canvasPath)))
    }),
  )

  // The linear draft: the canvas compiled into ordered blocks
  // ({ section, cards: [{ id, text }] }) in true narrative order — sections
  // left→right, cards top→bottom within each. Read-only; powers `read_draft`.
  app.get(
    '/projects/:id/draft',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json({ blocks: snapshotToDraft(await readCanvas(paths.canvasPath)) })
    }),
  )

  // Drill-down: full digests (text, comments, reference) for specific card ids.
  app.post(
    '/projects/:id/cards',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const ids = req.body?.ids
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) {
        res.status(400).json({ error: 'ids must be a string array' })
        return
      }
      // Reading specific cards is the agent "looking" here — surface it as
      // ephemeral presence so open tabs can glow those cards. A pure read: it
      // touches no document state, and read_map (the whole-board scan) stays
      // silent by design.
      if (ids.length) onPresence?.(req.params.id, { cardIds: ids, mode: 'looking' })
      res.json({ cards: snapshotToCardsById(await readCanvas(paths.canvasPath), ids, paths.assetsDir) })
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
      // A new note card (e.g. a long transcribed note) may need summarizing;
      // set_summary change-sets themselves settle to a no-op on the next pass.
      scheduleSummaries(req.params.id)
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
