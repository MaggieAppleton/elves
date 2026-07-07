import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'
import { attachRealtime } from './realtime'
import { migrateLegacyCanvas } from './migrate'
import { migrateSourceCardsToNotes } from './migrateNotes'
import { listProjects, canvasPathFor, resyncProjectIds } from './projects'
import { OllamaSummarizer, reconcileCanvasFile, type Summarizer } from './summarize'

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')
const port = Number(process.env.PORT ?? 5199)

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

  const httpServer = http.createServer()
  const { broadcast, broadcastPresence } = attachRealtime(httpServer)
  const summarizer = new OllamaSummarizer()
  const now = () => new Date().toISOString()
  const app = createServer(dataRoot, broadcast, { summarizer, now }, broadcastPresence)
  httpServer.on('request', app)

  httpServer.listen(port, () => {
    console.log(`Elves server on http://localhost:${port}  (data: ${dataRoot}, summarizer: ${summarizer.label})`)
  })

  // Backfill summaries for cards that don't have a current one yet, so the
  // zoom-out view works on existing canvases without waiting for an edit. The
  // hash guard makes this a no-op after the first run, and it degrades to
  // nothing (never throws) when the summarizer is unreachable.
  void backfillSummaries(dataRoot, summarizer, now, broadcast)
}

async function backfillSummaries(
  dataRoot: string,
  summarizer: Summarizer,
  now: () => string,
  broadcast: (projectId: string, cs: import('../src/model/changeset').ChangeSet) => void,
): Promise<void> {
  try {
    for (const project of await listProjects(dataRoot)) {
      const canvasPath = canvasPathFor(dataRoot, project.id)
      if (!canvasPath) continue
      const cs = await reconcileCanvasFile(canvasPath, summarizer, now)
      if (cs) broadcast(project.id, cs)
    }
  } catch (err) {
    console.error('[elves] summary backfill failed:', err)
  }
}

main().catch((err) => {
  console.error('Elves server failed to start:', err)
  process.exit(1)
})
