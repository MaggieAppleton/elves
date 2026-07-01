import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'
import { attachRealtime } from './realtime'

const here = dirname(fileURLToPath(import.meta.url))
const dataPath = process.env.ELVES_CANVAS ?? join(here, '..', 'data', 'canvas.json')
const port = Number(process.env.PORT ?? 5199)

const httpServer = http.createServer()
const { broadcast } = attachRealtime(httpServer)
const app = createServer(dataPath, broadcast)
httpServer.on('request', app)

httpServer.listen(port, () => {
  console.log(`Elves server on http://localhost:${port}  (canvas: ${dataPath})`)
})
