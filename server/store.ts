import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export type CanvasSnapshot = Record<string, unknown>

export const EMPTY_CANVAS: CanvasSnapshot = { document: null, session: null }

export async function readCanvas(path: string): Promise<CanvasSnapshot> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ...EMPTY_CANVAS }
    }
    throw err
  }
  // An empty file means a torn/partial write (or a freshly-touched file). Treat
  // it like a missing canvas instead of crashing on JSON.parse(''). A non-empty
  // file that fails to parse is genuine corruption, so we let that throw.
  if (raw.trim() === '') return { ...EMPTY_CANVAS }
  return JSON.parse(raw) as CanvasSnapshot
}

// Serialize all writes through a single promise chain so two writes can never
// interleave on disk, and give each write a unique temp file so even an
// out-of-band writer (a second process, a manual script) can't collide on the
// temp path — the collision that caused ENOENT-on-rename crashes.
let writeChain: Promise<void> = Promise.resolve()
let tmpSeq = 0

export function writeCanvas(path: string, data: CanvasSnapshot): Promise<void> {
  // Chain off the previous write regardless of whether it resolved or rejected,
  // so one failed write never stalls the queue for the next one.
  const run = writeChain.then(
    () => doWrite(path, data),
    () => doWrite(path, data),
  )
  // The chain itself must stay unrejected (an unhandled rejection here would be
  // fatal); the caller still receives the real promise and sees success/failure.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

async function doWrite(path: string, data: CanvasSnapshot): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, path)
}
