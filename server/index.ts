import 'dotenv/config'
import http from 'node:http'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'
import { attachRealtime } from './realtime'
import { createSelectionStore } from './selection'
import { migrateLegacyCanvas } from './migrate'
import { migrateSourceCardsToNotes } from './migrateNotes'
import { listProjects, resyncProjectIds } from './projects'
import { warnOnSyncConflicts } from './conflicts'
import { OllamaSummarizer } from './summarize'
import { resolveHost } from './host'
import { createAgentRunner } from './agentRun'
import type { CanvasServer } from './app'
import { acquireDataRootOwnership, type DataRootOwnership } from './dataRootOwnership'

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')
const port = Number(process.env.PORT ?? 5199)
const host = resolveHost()

async function main() {
  // Claim the canonical data root before migrations, project reads, temporary
  // server setup, or binding a port. The marker lives outside synced data.
  const testRuntimeRoot = process.env.NODE_ENV === 'test'
    ? process.env.ELVES_TEST_OWNERSHIP_RUNTIME
    : undefined
  let ownership: DataRootOwnership | undefined
  let httpServer: http.Server | undefined
  let closeRealtime: (() => void) | undefined
  let shutdownRuntime: (() => Promise<void>) | undefined
  let backgroundTask: Promise<void> | undefined
  let shutdownRequested = false
  let resolveShutdown: (() => void) | undefined
  const shutdownSignal = new Promise<void>((resolve) => { resolveShutdown = resolve })
  const requestShutdown = () => {
    shutdownRequested = true
    resolveShutdown?.()
  }
  const checkShutdown = () => {
    if (shutdownRequested) throw new ShutdownRequested()
  }
  process.once('SIGINT', requestShutdown)
  process.once('SIGTERM', requestShutdown)
  try {
    ownership = await acquireDataRootOwnership(dataRoot, { runtimeRoot: testRuntimeRoot })
    checkShutdown()
    await interruptibleBootstrapPause(checkShutdown)
    const running = await serve(ownership, checkShutdown, (server, close, shutdown) => {
      httpServer = server
      closeRealtime = close
      shutdownRuntime = shutdown
    })
    backgroundTask = running.backgroundTask
    await shutdownSignal
  } catch (error) {
    if (!(error instanceof ShutdownRequested)) throw error
  } finally {
    process.off('SIGINT', requestShutdown)
    process.off('SIGTERM', requestShutdown)
    closeRealtime?.()
    await shutdownRuntime?.()
    if (httpServer) await closeHttpServer(httpServer)
    await backgroundTask
    await ownership?.release().catch((releaseError) =>
      console.error('[elves] failed to release data-root ownership:', releaseError),
    )
  }
}

class ShutdownRequested extends Error {}

async function serve(
  ownership: DataRootOwnership,
  checkShutdown: () => void,
  registerServer: (
    server: http.Server,
    closeRealtime: () => void,
    shutdownRuntime: () => Promise<void>,
  ) => void,
) {
  const ownedDataRoot = ownership.canonicalRoot
  // Bring a single-canvas install up to the multi-project layout before serving.
  await migrateLegacyCanvas(ownedDataRoot, new Date().toISOString())
  checkShutdown()
  // Then rename any stored 'source' cards to 'note' so the server reads the same
  // shape the client writes (see migrateSourceCardsToNotes for why this is needed).
  await migrateSourceCardsToNotes(ownedDataRoot)
  checkShutdown()
  // Bring any project whose id drifted from its display name back in sync (folder
  // renamed to match slugify(name)). Idempotent; a no-op once everything matches.
  // Degrades to a log rather than blocking startup if a project is malformed
  // or a rename fails partway through.
  try {
    await resyncProjectIds(ownedDataRoot)
  } catch (err) {
    console.error('[elves] project id resync failed:', err)
  }
  checkShutdown()
  // Surface any Syncthing cross-machine divergence loudly at boot (advisory only).
  await warnOnSyncConflicts(ownedDataRoot)
  checkShutdown()

  const httpServer = http.createServer()
  const { broadcast, broadcastPresence, broadcastReviews, close } = attachRealtime(httpServer)
  const summarizer = new OllamaSummarizer()
  const backfillController = new AbortController()
  let agent: ReturnType<typeof createAgentRunner> | undefined
  registerServer(httpServer, close, async () => {
    backfillController.abort()
    summarizer.close()
    await agent?.shutdown?.()
  })
  const now = () => new Date().toISOString()
  const selection = createSelectionStore()
  // Drives the in-app chat box: spawns the configured CLI (ELVES_CLI, default
  // `claude`) as a headless agent that connects back to THIS server. We generate
  // the child's MCP config rather than reuse the repo's static .mcp.json so its
  // `elves` server points at this server's ACTUAL url (honoring a custom PORT,
  // which the committed .mcp.json can't), and so the run's authorship id
  // (ELVES_AGENT) matches the chosen CLI. Written once at startup to a temp file.
  const repoRoot = join(here, '..')
  const serverUrl = `http://localhost:${port}`
  const agentId = process.env.ELVES_AGENT ?? (process.env.ELVES_CLI || 'claude')
  const mcpConfigPath = join(tmpdir(), `elves-agent-mcp-${port}.json`)
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      mcpServers: {
        elves: {
          command: 'npx',
          args: ['tsx', join(repoRoot, 'mcp', 'index.ts')],
          env: { ELVES_URL: serverUrl, ELVES_AGENT: agentId },
        },
      },
    }),
  )
  agent = createAgentRunner({ mcpConfigPath, cwd: repoRoot, cliName: process.env.ELVES_CLI })
  const app = createServer(
    ownedDataRoot,
    broadcast,
    { summarizer, now },
    broadcastPresence,
    selection,
    agent,
    broadcastReviews,
  )
  httpServer.on('request', app)

  // Binds loopback-only by default (see server/host.ts) — set ELVES_HOST=0.0.0.0
  // to explicitly opt in to LAN/remote access.
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error)
    httpServer.once('error', onError)
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError)
      console.log(`Elves server on http://${host}:${port}  (data: ${ownedDataRoot}, summarizer: ${summarizer.label})`)
      resolveListen()
    })
  })
  checkShutdown()

  // Backfill summaries for cards that don't have a current one yet, so the
  // zoom-out view works on existing canvases without waiting for an edit. The
  // hash guard makes this a no-op after the first run, and it degrades to
  // nothing (never throws) when the summarizer is unreachable. Goes through
  // the app's own runSummaries so it shares the running/dirty single-flight
  // guard with scheduled reconciles — this backfill can never run concurrently
  // with a debounced reconcile for the same project.
  return { backgroundTask: backfillSummaries(ownedDataRoot, app, backfillController.signal) }
}

async function closeHttpServer(server: http.Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolveClose) => {
    server.close(() => resolveClose())
    server.closeAllConnections?.()
  })
}

async function interruptibleBootstrapPause(checkShutdown: () => void): Promise<void> {
  if (process.env.NODE_ENV !== 'test') return
  const pauseMs = Number(process.env.ELVES_TEST_BOOTSTRAP_PAUSE_MS ?? 0)
  if (!Number.isFinite(pauseMs) || pauseMs <= 0) return
  const deadline = Date.now() + pauseMs
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(10, deadline - Date.now())))
    checkShutdown()
  }
}

async function backfillSummaries(dataRoot: string, app: CanvasServer, signal: AbortSignal): Promise<void> {
  try {
    for (const project of await listProjects(dataRoot)) {
      if (signal.aborted) return
      await app.runSummaries(project.id)
    }
  } catch (err) {
    console.error('[elves] summary backfill failed:', err)
  }
}

main().catch((err) => {
  console.error('Elves server failed to start:', err)
  process.exit(1)
})
