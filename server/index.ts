import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer } from './app'

const here = dirname(fileURLToPath(import.meta.url))
const dataPath = process.env.ELVES_CANVAS ?? join(here, '..', 'data', 'canvas.json')
const port = Number(process.env.PORT ?? 5199)

createServer(dataPath).listen(port, () => {
  console.log(`Elves server on http://localhost:${port}  (canvas: ${dataPath})`)
})
