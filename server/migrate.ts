import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { projectsRoot, type Project } from './projects'

/**
 * One-time migration from the single-canvas layout (data/canvas.json + data/assets/)
 * to the multi-project layout (data/projects/<id>/...). Moves the legacy canvas and
 * assets into a "my-first-essay" project.
 *
 * Idempotent and safe to call on every startup:
 *  - if data/projects/ already exists, do nothing (already migrated / multi-project);
 *  - if there is no legacy canvas.json, do nothing (fresh install — no projects/ yet,
 *    the UI prompts the user to create their first project).
 */
export async function migrateLegacyCanvas(dataRoot: string, createdAt: string): Promise<void> {
  try {
    await fs.stat(projectsRoot(dataRoot))
    return // projects/ exists — nothing to migrate
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  const legacyCanvas = join(dataRoot, 'canvas.json')
  try {
    await fs.stat(legacyCanvas)
  } catch {
    return // no legacy canvas — fresh install
  }

  const dir = join(projectsRoot(dataRoot), 'my-first-essay')
  await fs.mkdir(dir, { recursive: true })
  await fs.rename(legacyCanvas, join(dir, 'canvas.json'))
  try {
    await fs.rename(join(dataRoot, 'assets'), join(dir, 'assets'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  const meta: Project = { id: 'my-first-essay', name: 'My first essay', createdAt }
  await fs.writeFile(join(dir, 'project.json'), JSON.stringify(meta, null, 2), 'utf8')
}
