import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'
import { attachRealtime } from './realtime'
import { migrateLegacyCanvas } from './migrate'

const here = dirname(fileURLToPath(import.meta.url))
const dataRoot = process.env.ELVES_DATA ?? join(here, '..', 'data')
const port = Number(process.env.PORT ?? 5199)

async function main() {
  // Bring a single-canvas install up to the multi-project layout before serving.
  await migrateLegacyCanvas(dataRoot, new Date().toISOString())

  const httpServer = http.createServer()
  const { broadcast } = attachRealtime(httpServer)
  const app = createServer(dataRoot, broadcast)
  httpServer.on('request', app)

  httpServer.listen(port, () => {
    console.log(`Elves server on http://localhost:${port}  (data: ${dataRoot})`)
  })
}

main().catch((err) => {
  console.error('Elves server failed to start:', err)
  process.exit(1)
})
