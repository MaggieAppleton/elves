import 'dotenv/config'
import http from 'node:http'
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

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')
const port = Number(process.env.PORT ?? 5199)
const host = resolveHost()

async function main() {
  // Bring a single-canvas install up to the multi-project layout before serving.
  await migrateLegacyCanvas(dataRoot, new Date().toISOString())
  // Then rename any stored 'source' cards to 'note' so the server reads the same
  // shape the client writes (see migrateSourceCardsToNotes for why this is needed).
  await migrateSourceCardsToNotes(dataRoot)
  // Bring any project whose id drifted from its display name back in sync (folder
  // renamed to match slugify(name)). Idempotent; a no-op once everything matches.
  // Degrades to a log rather than blocking startup if a project is malformed
  // or a rename fails partway through.
  try {
    await resyncProjectIds(dataRoot)
  } catch (err) {
    console.error('[elves] project id resync failed:', err)
  }
  // Surface any Syncthing cross-machine divergence loudly at boot (advisory only).
  await warnOnSyncConflicts(dataRoot)

  const httpServer = http.createServer()
  const { broadcast, broadcastPresence } = attachRealtime(httpServer)
  const summarizer = new OllamaSummarizer()
  const now = () => new Date().toISOString()
  const selection = createSelectionStore()
  // Drives the in-app chat box: spawns the configured CLI (ELVES_CLI, default
  // `claude`) as a headless agent, from the repo root so its `elves` MCP config
  // (.mcp.json → mcp/index.ts, relative paths) resolves. The child connects back
  // to this same canvas server.
  const repoRoot = join(here, '..')
  const agent = createAgentRunner({
    mcpConfigPath: join(repoRoot, '.mcp.json'),
    cwd: repoRoot,
    cliName: process.env.ELVES_CLI,
  })
  const app = createServer(dataRoot, broadcast, { summarizer, now }, broadcastPresence, selection, agent)
  httpServer.on('request', app)

  // Binds loopback-only by default (see server/host.ts) — set ELVES_HOST=0.0.0.0
  // to explicitly opt in to LAN/remote access.
  httpServer.listen(port, host, () => {
    console.log(`Elves server on http://${host}:${port}  (data: ${dataRoot}, summarizer: ${summarizer.label})`)
  })

  // Backfill summaries for cards that don't have a current one yet, so the
  // zoom-out view works on existing canvases without waiting for an edit. The
  // hash guard makes this a no-op after the first run, and it degrades to
  // nothing (never throws) when the summarizer is unreachable. Goes through
  // the app's own runSummaries so it shares the running/dirty single-flight
  // guard with scheduled reconciles — this backfill can never run concurrently
  // with a debounced reconcile for the same project.
  void backfillSummaries(dataRoot, app)
}

async function backfillSummaries(dataRoot: string, app: CanvasServer): Promise<void> {
  try {
    for (const project of await listProjects(dataRoot)) {
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
