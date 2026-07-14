import express, { Request, Response } from 'express'
import cors from 'cors'
import {
  readCanvas, withCanvasLock, replaceCanvasWithTombstone,
  EmptyCanvasOverwriteError, CanvasSnapshot,
} from './store'
import {
  isChangeSet,
  ChangeSet,
  changeSetWritesText,
} from '../src/model/changeset'
import type { PresenceMessage } from '../src/model/presence'
import {
  snapshotToCardMap, snapshotToCardsById, snapshotToDraft,
} from './digest'
import { enrichSelection, type SelectionStore } from './selection'
import type { AgentRunner, AgentEvent } from './agentRun'
import { reconcileCanvasFile, type Summarizer } from './summarize'
import { extForMime, saveAsset, resolveAssetPath } from './assets'
import { unfurl, type UnfurlDeps, type FetchedImage } from './unfurl'
import { safeFetch } from './ssrf'
import { getAllowedOrigins, isOriginAllowed } from './origins'
import {
  listProjects,
  createProject,
  renameProject,
  getProject,
  canvasPathFor,
  assetsDirFor,
  ProjectError,
} from './projects'
import { withProjectLock } from './projectLock'
import { readReviews, createReview, transitionReview, reviewsPathFor, ReviewError } from './reviews'
import { isPersonalityId, isReviewStatus, PERSONALITY_IDS, type Review } from '../src/model/reviews'
import {
  CanvasRevisionExhaustedError,
  PendingMaterializationIncompleteError,
  canvasRevision,
  clearCanvasSnapshot,
  ensureCanvasMetadata,
  nextChangeSetToken,
  pendingChangeSetsForClient,
  publicCanvasSnapshot,
  replaceCanvasSnapshot,
  type ChangeSetToken,
} from './canvasMetadata'
import { changeSetDigest, validateChangeSetBounds } from './changeSetIdentity'
import { admitLegacyChangeSet, admitTokenizedChangeSet } from './changeSetAdmission'

const UNFURL_UA = 'ElvesBot/0.1 (+local-first writing studio; reference unfurl)'
const FETCH_TIMEOUT_MS = 8000
const MAX_HTML_BYTES = 2_000_000
const MAX_IMAGE_BYTES = 5_000_000
const CANVAS_REVISION_HEADER = 'x-elves-canvas-revision'

type ProjectPaths = { canvasPath: string; assetsDir: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCanvasRevisionHeader(value: string | undefined):
  | { ok: true; revision: number }
  | { ok: false; code: 'canvas-revision-required' | 'invalid-canvas-revision' } {
  if (value === undefined) return { ok: false, code: 'canvas-revision-required' }
  if (!/^(0|[1-9]\d*)$/.test(value)) return { ok: false, code: 'invalid-canvas-revision' }
  const revision = Number(value)
  return Number.isSafeInteger(revision)
    ? { ok: true, revision }
    : { ok: false, code: 'invalid-canvas-revision' }
}

function parseChangeSetToken(value: unknown): ChangeSetToken | null {
  if (!isRecord(value) || typeof value.epoch !== 'string' || value.epoch.length === 0 ||
    !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) return null
  return { epoch: value.epoch, sequence: value.sequence as number }
}

class CanvasRevisionConflictError extends Error {
  constructor(readonly revision: number) {
    super('canvas revision conflict')
  }
}

class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`response body exceeds ${limit} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

type FetchResponse = Awaited<ReturnType<typeof safeFetch>>

async function discardBody(res: FetchResponse): Promise<void> {
  await res.body?.cancel()
}

async function readBodyLimited(res: FetchResponse, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason
      if (done) break
      total += value.byteLength
      if (total > limit) {
        const error = new BodyTooLargeError(limit)
        void reader.cancel(error).catch(() => undefined)
        throw error
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

// Real network + asset I/O for unfurl, scoped to one project's assets dir. The
// fetches are http(s)-only, time-limited, and size-capped; images are stored as
// local files so a reference card stays offline-usable and portable.
function unfurlDepsFor(dataRoot: string, projectId: string): UnfurlDeps {
  // SSRF-guarded: safeFetch resolves + range-checks the hostname of the
  // initial URL AND of every redirect hop (never `redirect: 'follow'`), so a
  // pasted URL can't reach this machine's own network or a cloud metadata
  // endpoint, even via a redirect chain. See server/ssrf.ts.
  const withTimeout = async <T>(
    url: string,
    accept: string,
    consume: (res: FetchResponse, signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await safeFetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': UNFURL_UA, accept },
      })
      return await consume(res, ctrl.signal)
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    fetchText: async (url) => withTimeout(url, 'text/html,application/xhtml+xml', async (res, signal) => {
      const ct = (res.headers.get('content-type') ?? '').toLowerCase()
      if (!res.ok || !ct.includes('html')) {
        await discardBody(res)
        throw new Error(`not html (${res.status})`)
      }
      const html = (await readBodyLimited(res, MAX_HTML_BYTES, signal)).toString('utf8')
      return { html, finalUrl: res.url || url }
    }),
    fetchImage: async (url): Promise<FetchedImage | null> => {
      try {
        return await withTimeout(url, 'image/*', async (res, signal) => {
          const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
          if (!res.ok || !contentType.startsWith('image/')) {
            await discardBody(res)
            return null
          }
          const bytes = await readBodyLimited(res, MAX_IMAGE_BYTES, signal)
          return bytes.length === 0 ? null : { bytes, contentType }
        })
      } catch {
        return null
      }
    },
    saveImage: async (img) => {
      const ext = extForMime(img.contentType)
      if (!ext) return null
      return withProjectLock(dataRoot, projectId, async () => {
        if (!(await getProject(dataRoot, projectId))) return null
        const assetsDir = assetsDirFor(dataRoot, projectId)
        return assetsDir ? saveAsset(assetsDir, img.bytes, ext) : null
      })
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
  /** Backoff for retrying reconciles left pending by an unreachable summarizer. */
  retryBaseMs?: number
  retryMaxMs?: number
}

/**
 * The Express app plus `runSummaries`, exposed so callers outside a request
 * (e.g. server/index.ts's startup backfill) can reconcile a project through
 * the SAME running/dirty single-flight guard as scheduled reconciles — a
 * project's canvas is never reconciled by two summarizer runs at once.
 */
export interface CanvasServer extends express.Express {
  runSummaries(projectId: string): Promise<void>
}

export function createServer(
  dataRoot: string,
  onChangeSet?: (projectId: string, cs: ChangeSet) => void,
  summarize?: SummarizeConfig,
  onPresence?: (projectId: string, presence: PresenceMessage) => void,
  selection?: SelectionStore,
  agent?: AgentRunner,
  onReviews?: (projectId: string, reviews: Review[]) => void,
): CanvasServer {
  const app = express()
  // Origin allowlist (see server/origins.ts): only same-origin/no-Origin
  // requests (curl, tests, server-to-server) and the localhost client dev
  // port / this server's own port may read responses cross-origin. This is
  // what stops an arbitrary web page from calling this API from the
  // browser. Widen with ELVES_ALLOWED_ORIGINS if needed.
  //
  // FOLLOW-UP (out of scope for issue #29's network-boundary hardening):
  // there is still no request auth (shared-token or otherwise) — any process
  // that CAN reach this origin (e.g. another app on the same machine, once
  // it knows/guesses the port) can call every route unauthenticated. Shared-
  // token auth is tracked separately and deliberately not implemented here.
  const allowedOrigins = getAllowedOrigins()
  app.use(cors({
    origin(origin, callback) {
      callback(null, isOriginAllowed(origin, allowedOrigins))
    },
  }))
  app.use(express.json({ limit: '64mb' }))

  // --- Summary reconciliation scheduler -------------------------------------
  // Debounce rapid saves per project, and never run two reconciles for the same
  // project at once (a save during a run re-marks it dirty and re-runs after).
  const now = summarize?.now ?? (() => new Date().toISOString())
  const debounceMs = summarize?.debounceMs ?? 1500
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Set<string>()
  const dirty = new Set<string>()

  // Retry state: when a reconcile leaves work `pending` (the summarizer was
  // unreachable, e.g. Ollama down), schedule a backoff re-run per project so
  // it self-heals once the summarizer recovers — no save or restart needed.
  // The retry re-enters runSummaries, so it shares the SAME running/dirty
  // single-flight guard above: a retry firing mid-debounced-reconcile just
  // marks the project dirty rather than racing it.
  const retryBaseMs = summarize?.retryBaseMs ?? 5_000
  const retryMaxMs = summarize?.retryMaxMs ?? 60_000
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const retryDelay = new Map<string, number>()

  function scheduleRetry(projectId: string): void {
    if (retryTimers.has(projectId)) return // one pending retry per project
    const delay = Math.min(retryDelay.get(projectId) ?? retryBaseMs, retryMaxMs)
    retryDelay.set(projectId, Math.min(delay * 2, retryMaxMs))
    const timer = setTimeout(() => {
      retryTimers.delete(projectId)
      void runSummaries(projectId)
    }, delay)
    timer.unref?.()
    retryTimers.set(projectId, timer)
  }

  function clearRetry(projectId: string): void {
    const t = retryTimers.get(projectId)
    if (t) clearTimeout(t)
    retryTimers.delete(projectId)
    retryDelay.delete(projectId)
  }

  async function runSummaries(projectId: string): Promise<void> {
    if (!summarize) return
    if (running.has(projectId)) {
      dirty.add(projectId)
      return
    }
    running.add(projectId)
    try {
      if (await getProject(dataRoot, projectId)) {
        const { changeSet, pending } = await reconcileCanvasFile(dataRoot, projectId, summarize.summarizer, now)
        if (changeSet) onChangeSet?.(projectId, changeSet)
        if (pending) scheduleRetry(projectId)
        else clearRetry(projectId)
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
  ): Promise<ProjectPaths | null> {
    const canvasPath = canvasPathFor(dataRoot, id)
    const assetsDir = assetsDirFor(dataRoot, id)
    if (!canvasPath || !assetsDir || !(await getProject(dataRoot, id))) {
      res.status(404).json({ error: 'unknown project' })
      return null
    }
    return { canvasPath, assetsDir }
  }

  async function withProjectMutation<T>(
    id: string,
    res: Response,
    task: (paths: ProjectPaths) => Promise<T>,
  ): Promise<T | null> {
    return withProjectLock(dataRoot, id, async () => {
      const paths = await requireProject(id, res)
      return paths ? task(paths) : null
    })
  }

  async function ensureStoredCanvasMetadata(path: string): Promise<CanvasSnapshot> {
    let snapshot: CanvasSnapshot | undefined
    await withCanvasLock(path, (current) => {
      const ensured = ensureCanvasMetadata(current)
      snapshot = ensured.snapshot
      return ensured.created ? ensured.snapshot : null
    })
    return snapshot!
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
      if (req.query.protocol === '2') {
        const canvas = await withProjectMutation(req.params.id, res, async (paths) =>
          ensureStoredCanvasMetadata(paths.canvasPath))
        if (canvas === null) return
        res.json({
          snapshot: publicCanvasSnapshot(canvas),
          revision: canvasRevision(canvas),
          pendingChangeSets: pendingChangeSetsForClient(canvas),
          nextChangeSetToken: nextChangeSetToken(canvas),
        })
        return
      }
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json(publicCanvasSnapshot(await readCanvas(paths.canvasPath)))
    }),
  )

  app.get(
    '/projects/:id/changeset-token',
    wrap(async (req, res) => {
      const canvas = await withProjectMutation(req.params.id, res, async (paths) =>
        ensureStoredCanvasMetadata(paths.canvasPath))
      if (canvas === null) return
      res.json({ revision: canvasRevision(canvas), token: nextChangeSetToken(canvas) })
    }),
  )

  app.post(
    '/projects/:id/canvas',
    wrap(async (req, res) => {
      const preflight = await requireProject(req.params.id, res)
      if (!preflight) return
      const body = req.body
      if (!isRecord(body)) {
        res.status(400).json({ error: 'canvas must be a JSON object' })
        return
      }
      const versioned = req.query.protocol === '2'
      const parsedRevision = versioned
        ? parseCanvasRevisionHeader(req.get(CANVAS_REVISION_HEADER))
        : null
      if (parsedRevision && !parsedRevision.ok) {
        res.status(400).json({
          code: parsedRevision.code,
          error: parsedRevision.code === 'canvas-revision-required'
            ? 'canvas revision header required'
            : 'invalid canvas revision',
        })
        return
      }
      let observedRevision = 0
      let observedNextChangeSetToken: ChangeSetToken | null = null
      let savedRevision: number | null = null
      try {
        const saved = await withProjectMutation(
          req.params.id,
          res,
          async (paths) => {
            await withCanvasLock(paths.canvasPath, (current) => {
              observedRevision = canvasRevision(current)
              observedNextChangeSetToken = pendingChangeSetsForClient(current).length > 0
                ? nextChangeSetToken(current)
                : null
              if (parsedRevision?.ok && parsedRevision.revision !== observedRevision) return null
              const next = replaceCanvasSnapshot(current, body, { materializePending: versioned })
              savedRevision = canvasRevision(next)
              return next
            })
            return true
          },
        )
        if (saved === null) return
        if (parsedRevision?.ok && savedRevision === null) {
          res.status(409).json({
            code: 'canvas-revision-conflict',
            error: 'canvas revision conflict',
            revision: observedRevision,
          })
          return
        }
      } catch (err) {
        // A save that would blank a canvas holding a real document is refused,
        // never a silent data loss. To clear a canvas on purpose, use DELETE.
        if (err instanceof EmptyCanvasOverwriteError) {
          res.status(409).json({ error: 'refusing to blank a non-empty canvas; use DELETE to clear' })
          return
        }
        if (err instanceof PendingMaterializationIncompleteError) {
          res.status(409).json({
            code: 'pending-materialization-incomplete',
            error: err.message,
            revision: observedRevision,
            ...(observedNextChangeSetToken
              ? { nextChangeSetToken: observedNextChangeSetToken }
              : {}),
          })
          return
        }
        if (err instanceof CanvasRevisionExhaustedError) {
          res.status(507).json({
            code: 'canvas-revision-exhausted',
            error: err.message,
            revision: observedRevision,
          })
          return
        }
        throw err
      }
      // A canvas save is where user text edits land — reconcile summaries after.
      scheduleSummaries(req.params.id)
      res.json(versioned ? { ok: true, revision: savedRevision } : { ok: true })
    }),
  )

  // Explicitly clear a canvas back to empty (distinct from a save, which may
  // never blank a real document). The current document is preserved as a .bak.
  app.delete(
    '/projects/:id/canvas',
    wrap(async (req, res) => {
      if (req.query.protocol === '2') {
        const preflight = await requireProject(req.params.id, res)
        if (!preflight) return
        const parsed = parseCanvasRevisionHeader(req.get(CANVAS_REVISION_HEADER))
        if (!parsed.ok) {
          res.status(400).json({
            code: parsed.code,
            error: parsed.code === 'canvas-revision-required'
              ? 'canvas revision header required'
              : 'invalid canvas revision',
          })
          return
        }
        let observedRevision = 0
        try {
          const cleared = await withProjectMutation(req.params.id, res, async (paths) =>
            replaceCanvasWithTombstone(paths.canvasPath, (current) => {
              observedRevision = canvasRevision(current)
              if (parsed.revision !== observedRevision) {
                throw new CanvasRevisionConflictError(observedRevision)
              }
              return clearCanvasSnapshot(current)
            }))
          if (cleared === null) return
          res.json({ ok: true, revision: canvasRevision(cleared) })
        } catch (error) {
          if (error instanceof CanvasRevisionConflictError) {
            res.status(409).json({
              code: 'canvas-revision-conflict',
              error: error.message,
              revision: error.revision,
            })
            return
          }
          if (error instanceof CanvasRevisionExhaustedError) {
            res.status(507).json({
              code: 'canvas-revision-exhausted',
              error: error.message,
              revision: observedRevision,
            })
            return
          }
          throw error
        }
        return
      }
      let observedRevision = 0
      try {
        const cleared = await withProjectMutation(req.params.id, res, async (paths) =>
          replaceCanvasWithTombstone(paths.canvasPath, (current) => {
            observedRevision = canvasRevision(current)
            return clearCanvasSnapshot(current)
          }))
        if (cleared === null) return
        res.json({ ok: true })
      } catch (error) {
        if (error instanceof CanvasRevisionExhaustedError) {
          res.status(507).json({
            code: 'canvas-revision-exhausted',
            error: error.message,
            revision: observedRevision,
          })
          return
        }
        throw error
      }
    }),
  )

  // The cheap navigation map: sections + a small entry per card (gist, position,
  // textLen), no full text. The agent reads this first, then drills into specific
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

  // --- Selection awareness --------------------------------------------------
  // The browser reports its current canvas selection here (ephemeral, in-memory,
  // never persisted — see server/selection.ts). A single global slot: the last
  // report wins, carrying its project id so the agent can resolve "this" without
  // already knowing which project it's in. Dormant when no SelectionStore is
  // wired (tests that don't exercise selection), so those suites stay hermetic.
  app.post(
    '/projects/:id/selection',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const shapeIds = req.body?.shapeIds
      if (!Array.isArray(shapeIds) || !shapeIds.every((i) => typeof i === 'string')) {
        res.status(400).json({ error: 'shapeIds must be a string array' })
        return
      }
      selection?.set(req.params.id, shapeIds, now())
      res.json({ ok: true })
    }),
  )

  // Read the user's current selection — global, no project id required. The
  // agent calls this when the user says "this" / "these" / "the selected card".
  // Reported ids are enriched against the project's live canvas map (gists for
  // cards, text for sections/questions, member counts for groups); ids that no
  // longer exist are dropped. No selection yet, or the project it referenced is
  // gone, returns an empty list rather than an error — an absent selection is a
  // normal state, not a failure.
  app.get(
    '/selection',
    wrap(async (_req, res) => {
      const current = selection?.get()
      if (!current) {
        res.json({ selection: [] })
        return
      }
      const canvasPath = canvasPathFor(dataRoot, current.projectId)
      if (!canvasPath || !(await getProject(dataRoot, current.projectId))) {
        res.json({ selection: [] })
        return
      }
      const map = snapshotToCardMap(await readCanvas(canvasPath))
      res.json({
        project: current.projectId,
        selection: enrichSelection(map, current.shapeIds),
        selectedAt: current.selectedAt,
      })
    }),
  )

  // --- In-app agent runs ----------------------------------------------------
  // The chat box (`/` on the canvas) posts a prompt here; the server spawns the
  // configured CLI as a one-shot headless agent (see server/agentRun.ts) and
  // streams its transcript back as Server-Sent Events. The agent's canvas edits
  // still flow over the realtime WS as usual — this stream carries only its
  // reasoning + tool calls. One run at a time. Dormant when no runner is wired
  // (tests), so those suites stay hermetic.
  app.post('/agent/run', (req, res) => {
    if (!agent) {
      res.status(501).json({ error: 'agent runs are not configured on this server' })
      return
    }
    const prompt = req.body?.prompt
    const projectId = req.body?.projectId
    const runId = req.body?.runId
    const hasSelection = !!req.body?.hasSelection
    if (typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' })
      return
    }
    if (typeof projectId !== 'string' || !projectId) {
      res.status(400).json({ error: 'projectId is required' })
      return
    }
    if (typeof runId !== 'string' || !runId) {
      res.status(400).json({ error: 'runId is required' })
      return
    }
    if (agent.isRunning('chat')) {
      res.status(409).json({ error: 'an agent is already running' })
      return
    }
    // SSE: keep the socket open and push events as they arrive. `no-transform`
    // + `X-Accel-Buffering: no` stop any intermediary from buffering the stream.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.flushHeaders?.()
    const send = (e: AgentEvent) => {
      if (res.writable && !res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`)
    }
    // If the user closes the box mid-run we stop streaming, but let the agent
    // finish — its canvas edits are still wanted, and a run is short. The box's
    // Cancel button (POST /agent/cancel) is how you actually kill it. Detect that
    // on the RESPONSE, and only when it closes BEFORE we finished writing — the
    // request object's own 'close' fires the moment its body is read (normal
    // completion), which is not a disconnect.
    res.on('close', () => {
      if (!res.writableFinished) console.warn('[elves] agent run stream closed by client before completion')
    })
    agent
      .run('chat', { runId, prompt, projectId, hasSelection }, send)
      .catch((err) => {
        console.error('[elves] agent run failed:', err)
        send({ type: 'error', message: 'the agent run failed unexpectedly' })
      })
      .finally(() => {
        // Terminator so the client stops reading; a no-op if the socket is gone.
        if (res.writable && !res.writableEnded) res.write('event: end\ndata: {}\n\n')
        res.end()
      })
  })

  // Kill the specifically requested active run (the box's Cancel button).
  app.post('/agent/cancel', (req, res) => {
    if (!agent) {
      res.status(501).json({ error: 'agent runs are not configured on this server' })
      return
    }
    const runId = req.body?.runId
    if (typeof runId !== 'string' || !runId) {
      res.status(400).json({ error: 'runId is required' })
      return
    }
    const result = agent.cancel('chat', runId)
    if (result.status === 'accepted') {
      res.json({ ok: true })
      return
    }
    const message = result.status === 'not-running'
      ? 'there is no active agent run to cancel'
      : result.status === 'run-mismatch'
        ? 'the requested agent run is no longer active'
        : 'could not signal the active agent run'
    res.status(result.status === 'signal-failed' ? 503 : 409).json({ code: result.status, error: message })
  })

  app.post(
    '/projects/:id/changeset',
    wrap(async (req, res) => {
      // Preserve legacy unknown-project precedence while keeping all structural,
      // semantic-bound, and digest work outside both mutation locks.
      const preflight = await requireProject(req.params.id, res)
      if (!preflight) return
      const versioned = req.query.protocol === '2'
      const token = versioned ? parseChangeSetToken(req.body?.token) : null
      if (versioned && !token) {
        res.status(400).json({
          code: 'invalid-changeset-token',
          error: 'invalid change-set token',
        })
        return
      }
      const candidate = versioned ? req.body?.changeSet : req.body
      if (!isChangeSet(candidate)) {
        res.status(400).json({ code: 'invalid-change-set', error: 'invalid change-set' })
        return
      }
      if (changeSetWritesText(candidate)) {
        res.status(403).json({ error: 'change-set may not write card text' })
        return
      }
      const bounds = validateChangeSetBounds(candidate)
      if (!bounds.ok) {
        res.status(413).json({ code: bounds.code, error: 'change-set exceeds semantic limits' })
        return
      }
      const changeSet = candidate
      const digest = changeSetDigest(changeSet)

      let decision: ReturnType<typeof admitTokenizedChangeSet> | ReturnType<typeof admitLegacyChangeSet>
        | undefined
      let observedRevision = 0
      const mutation = await withProjectMutation(req.params.id, res, async (paths) => {
        await withCanvasLock(paths.canvasPath, (canvas) => {
          const base = versioned
            ? ensureCanvasMetadata(canvas)
            : { snapshot: canvas, created: false }
          observedRevision = canvasRevision(base.snapshot)
          decision = versioned
            ? admitTokenizedChangeSet(base.snapshot, token!, changeSet, digest)
            : admitLegacyChangeSet(base.snapshot, changeSet, digest)
          return decision.kind === 'applied' || decision.kind === 'queued'
            ? decision.snapshot
            : base.created ? base.snapshot : null
        })
        return true
      })
      if (mutation === null || !decision) return

      if (versioned) {
        const result = decision as ReturnType<typeof admitTokenizedChangeSet>
        const state = { revision: result.revision, nextChangeSetToken: result.nextToken }
        if (result.kind === 'applied') {
          onChangeSet?.(req.params.id, changeSet)
          scheduleSummaries(req.params.id)
          res.json({ ok: true, ...state })
          return
        }
        if (result.kind === 'queued') {
          res.status(202).json({ ok: true, pending: true, ...state })
          return
        }
        if (result.kind === 'duplicate') {
          res.json({
            ok: true,
            duplicate: true,
            ...(result.payloadUnverified ? { payloadUnverified: true } : {}),
            ...state,
          })
          return
        }
        if (result.kind === 'conflict') {
          res.status(409).json({ code: result.code, error: result.code, ...state })
          return
        }
        if (result.kind === 'exhausted') {
          res.status(507).json({ code: result.code, error: result.code, ...state })
          return
        }
        if (result.kind === 'invalid-target') {
          res.status(409).json({
            code: 'invalid-target',
            error: result.invalidMergeReps.length
              ? 'merge_notes representative must be a note card'
              : 'target not in project',
            missing: result.missing,
            invalidMergeReps: result.invalidMergeReps,
            ...state,
          })
          return
        }
        const unavailable = result as Extract<typeof result, { kind: 'unavailable' }>
        res.status(unavailable.code === 'no-document' ? 409 : 507).json({
          code: unavailable.code,
          error: unavailable.code,
          ...state,
        })
        return
      }

      const result = decision as ReturnType<typeof admitLegacyChangeSet>
      if (result.kind === 'duplicate') {
        res.json({ ok: true, duplicate: true })
        return
      }
      if (result.kind === 'conflict') {
        res.status(409).json({ code: result.code, error: 'change-set id reused with another payload' })
        return
      }
      if (result.kind === 'invalid-target') {
        if (result.invalidMergeReps.length) {
          res.status(409).json({
            error: 'merge_notes representative must be a note card',
            invalidMergeReps: result.invalidMergeReps,
          })
        } else {
          res.status(409).json({ error: 'card not in project', missing: result.missing })
        }
        return
      }
      if (result.kind === 'exhausted') {
        res.status(507).json({
          code: result.code,
          error: 'canvas revision exhausted',
          revision: observedRevision,
        })
        return
      }
      if (result.kind === 'unapplied') {
        // Still broadcast, so a browser tab that happens to have the project
        // open can self-heal via the live connection — but don't claim
        // success or schedule summaries for something that never landed.
        onChangeSet?.(req.params.id, changeSet)
        res.status(409).json({
          error: 'project has no canvas yet — open it once in the app to initialize the canvas',
          applied: false,
        })
        return
      }
      onChangeSet?.(req.params.id, changeSet)
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
      const result = await withProjectMutation(
        req.params.id,
        res,
        async (paths) => {
          const ext = extForMime((req.headers['content-type'] ?? '').split(';')[0].trim())
          if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) {
            return { assetId: null }
          }
          return { assetId: await saveAsset(paths.assetsDir, req.body, ext) }
        },
      )
      if (result === null) return
      if (result.assetId === null) {
        res.status(400).json({ error: 'expected a non-empty image body' })
        return
      }
      res.json({ assetId: result.assetId })
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
  // request to the URL the user pasted / asked an agent to enrich — always an
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
      const reference = await unfurl(url, unfurlDepsFor(dataRoot, req.params.id))
      res.json({ reference })
    }),
  )

  // --- Review passes ----------------------------------------------------------
  // Summonable editor personalities (see src/model/reviews.ts). A review is
  // project metadata in reviews.json — not canvas content, not undoable — created
  // pending by the UI summon (or in-progress by a chat-initiated agent pass),
  // claimed and completed over these same endpoints by the MCP layer. Every
  // mutation broadcasts the fresh list so open panels update live.

  // The reviews path for a project that already passed requireProject — the id
  // is valid by then, so the null branch is unreachable in practice.
  function reviewsPath(id: string): string {
    const path = reviewsPathFor(dataRoot, id)
    if (!path) throw new Error(`no reviews path for project '${id}'`)
    return path
  }

  async function broadcastReviews(id: string): Promise<void> {
    if (onReviews) onReviews(id, await readReviews(reviewsPath(id)))
  }

  // Fire-and-forget: spawn an in-app agent to claim and run review <reviewId>,
  // reusing the SAME headless runner the chat box drives (server/agentRun.ts).
  // The spawned agent is "just another MCP client" — it calls start_review,
  // add_comment, complete_review exactly as an external agent would, so the
  // whole review state machine, comment tagging, and WS broadcasts are
  // untouched. No SSE stream here: the panel tracks progress over the reviews
  // WS broadcast (pending → in-progress → done), not a transcript.
  async function launchReviewRun(projectId: string, reviewId: string): Promise<void> {
    const key = `review:${reviewId}`
    if (!agent || agent.isRunning(key)) return // no runner wired, or already running: stays pending
    let lastError: string | null = null
    const prompt =
      `A review pass is waiting for you on this canvas, id \`${reviewId}\`. Call \`start_review\` with ` +
      `reviewId \`${reviewId}\`, follow the returned brief exactly, leave your comments tagged with that ` +
      `reviewId, and finish by calling \`complete_review\`. Do only this review — nothing else.`
    await agent.run(key, { runId: reviewId, prompt, projectId, hasSelection: false }, (e) => {
      if (e.type === 'error') lastError = e.message
    })
    // The child exited. If the pass never reached done (or wasn't dismissed
    // out from under it — e.g. the user × cancelled mid-run), mark it failed
    // so the panel shows Retry instead of leaving it stuck "Starting…" forever.
    try {
      const updated = await withProjectLock(dataRoot, projectId, async () => {
        if (!(await getProject(dataRoot, projectId))) return null
        const path = reviewsPath(projectId)
        const reviews = await readReviews(path)
        const review = reviews.find((r) => r.id === reviewId)
        if (review && (review.status === 'pending' || review.status === 'in-progress')) {
          await transitionReview(
            path,
            reviewId,
            { status: 'failed', error: lastError ?? 'the review agent stopped before finishing' },
            new Date().toISOString(),
          )
          return readReviews(path)
        }
        return null
      })
      if (updated && onReviews) onReviews(projectId, updated)
    } catch (err) {
      // Lost the race to done/dismissed between the read above and this write
      // (ReviewError 409) — the pass finished or was cancelled on its own
      // terms, which is the outcome we wanted anyway.
      if (!(err instanceof ReviewError)) throw err
    }
  }

  app.get(
    '/projects/:id/reviews',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      res.json({ reviews: await readReviews(reviewsPath(req.params.id)) })
    }),
  )

  app.post(
    '/projects/:id/reviews',
    wrap(async (req, res) => {
      const result = await withProjectMutation(
        req.params.id,
        res,
        async () => {
          const { personality, focus, agent } = req.body ?? {}
          if (!isPersonalityId(personality)) return { error: 'personality' as const, review: null }
          if (focus !== undefined && focus !== null && typeof focus !== 'string') {
            return { error: 'focus' as const, review: null }
          }
          if (agent !== undefined && agent !== null && (typeof agent !== 'string' || !agent)) {
            return { error: 'agent' as const, review: null }
          }
          const review = await createReview(
            reviewsPath(req.params.id),
            { personality, focus: focus ?? null, agent: agent ?? null },
            new Date().toISOString(),
          )
          return { error: null, review }
        },
      )
      if (result === null) return
      if (result.error === 'personality') {
        res.status(400).json({ error: 'unknown personality', valid: PERSONALITY_IDS })
        return
      }
      if (result.error === 'focus') {
        res.status(400).json({ error: 'focus must be a string' })
        return
      }
      if (result.error === 'agent') {
        res.status(400).json({ error: 'agent must be a non-empty string' })
        return
      }
      const review = result.review!
      await broadcastReviews(req.params.id)
      // A UI summon (no `agent` in the body) is born pending — launch the
      // in-app runner to claim and run it. An ad-hoc chat pass (`agent` given)
      // is already in-progress, claimed by the caller itself; nothing to launch.
      if (review.status === 'pending') {
        void launchReviewRun(req.params.id, review.id).catch((err) =>
          console.error('[elves] review run failed to launch:', err),
        )
      }
      res.json({ review })
    }),
  )

  // Retry: re-launch a run for a review stuck `failed` (or re-summon a
  // `pending` one that never got picked up). 202 — the launch is fire-and-
  // forget, same as the summon path; the panel watches progress over the
  // reviews WS broadcast.
  app.post(
    '/projects/:id/reviews/:reviewId/run',
    wrap(async (req, res) => {
      const paths = await requireProject(req.params.id, res)
      if (!paths) return
      const reviews = await readReviews(reviewsPath(req.params.id))
      const review = reviews.find((r) => r.id === req.params.reviewId)
      if (!review) {
        res.status(404).json({ error: 'unknown review' })
        return
      }
      // Only a stalled pass is re-runnable. A finished (`done`) or cleared
      // (`dismissed`) review would just spawn a CLI whose start_review claim the
      // state machine rejects anyway — refuse up front instead of wasting it.
      if (review.status !== 'failed' && review.status !== 'pending') {
        res.status(409).json({ error: `cannot re-run a ${review.status} review` })
        return
      }
      void launchReviewRun(req.params.id, req.params.reviewId).catch((err) =>
        console.error('[elves] review run failed to launch:', err),
      )
      res.status(202).json({ ok: true })
    }),
  )

  app.post(
    '/projects/:id/reviews/:reviewId/status',
    wrap(async (req, res) => {
      try {
        const result = await withProjectMutation(req.params.id, res, async (paths) => {
          const { status, agent: agentId, verdict, error } = req.body ?? {}
          if (!isReviewStatus(status)) return { kind: 'invalid-status' as const }
          // Dismissing a running pass must kill its child before transitioning,
          // otherwise the runner's completion handler can re-mark it failed.
          if (status === 'dismissed') {
            const cancelled = agent?.cancel(`review:${req.params.reviewId}`, req.params.reviewId)
            if (cancelled?.status === 'signal-failed' || cancelled?.status === 'run-mismatch') {
              return { kind: 'cancel-failed' as const, cancelled }
            }
          }
          // Completion stamps the pass's comment footprint, so it needs the
          // canvas as it stands; the other transitions never read the document.
          const canvas = status === 'done' ? await readCanvas(paths.canvasPath) : null
          const review = await transitionReview(
            reviewsPath(req.params.id),
            req.params.reviewId,
            { status, agent: agentId ?? null, verdict: verdict ?? null, error: error ?? null },
            new Date().toISOString(),
            canvas,
          )
          return { kind: 'transitioned' as const, review }
        })
        if (result === null) return
        if (result.kind === 'invalid-status') {
          res.status(400).json({ error: 'unknown status' })
          return
        }
        if (result.kind === 'cancel-failed') {
          const message = result.cancelled.status === 'run-mismatch'
            ? 'the requested review run is no longer active'
            : 'could not signal the active review run'
          res.status(result.cancelled.status === 'signal-failed' ? 503 : 409).json({
            code: result.cancelled.status,
            error: message,
          })
          return
        }
        await broadcastReviews(req.params.id)
        res.json({ review: result.review })
      } catch (err) {
        if (err instanceof ReviewError) {
          res.status(err.status).json({ error: err.message })
          return
        }
        throw err
      }
    }),
  )

  const server = app as CanvasServer
  server.runSummaries = runSummaries
  return server
}
