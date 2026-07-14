import { listProjects, getProject, canvasPathFor } from './projects'
import { withProjectLock } from './projectLock'
import { withCanvasLock } from './store'
import { incrementCanvasRevision } from './canvasMetadata'

/**
 * One-time, in-place rename of the card discriminators in every stored canvas:
 * `kind: 'source'` → `'note'` and the `sourceKind` prop → `noteKind`, matching
 * the code rename that made "note" the canonical word for these cards.
 *
 * The client migrates on load (a tldraw shape migration, RenameSourceToNote), but
 * the SERVER reads canvas.json as raw JSON — it never runs tldraw migrations — so
 * without this a change-set applied before the canvas was next opened in the
 * browser would read stale `kind: 'source'` and silently miss cards. Converting on
 * disk keeps the server and the client seeing the same shape from the first boot.
 *
 * Idempotent and safe on every startup: a canvas already in the new shape has no
 * matching records, so it is left untouched (no rewrite, no churn). Never throws —
 * a single bad file is logged and skipped, like the summary backfill.
 */
export async function migrateSourceCardsToNotes(dataRoot: string): Promise<void> {
  let projects
  try {
    projects = await listProjects(dataRoot)
  } catch {
    return // no projects/ yet — nothing to migrate
  }

  for (const project of projects) {
    try {
      await withProjectLock(dataRoot, project.id, async () => {
        if (!(await getProject(dataRoot, project.id))) return
        const path = canvasPathFor(dataRoot, project.id)
        if (!path) return
        await withCanvasLock(path, (current) => {
          if (!renameCardsInSnapshot(current)) return null
          return incrementCanvasRevision(current)
        })
      })
    } catch (err) {
      console.error(`[elves] note rename skipped for ${project.id}:`, err)
    }
  }
}

/** Rewrites card records in a snapshot's store; returns true iff anything changed. */
function renameCardsInSnapshot(snapshot: Record<string, unknown>): boolean {
  const doc = snapshot?.document as { store?: Record<string, any> } | null | undefined
  const store = doc?.store
  if (!store) return false

  let changed = false
  for (const record of Object.values(store)) {
    if (!record || record.typeName !== 'shape' || record.type !== 'card' || !record.props) continue
    const props = record.props as Record<string, unknown>
    if (props.kind === 'source') {
      props.kind = 'note'
      changed = true
    }
    if ('sourceKind' in props) {
      props.noteKind = props.sourceKind
      delete props.sourceKind
      changed = true
    }
  }
  return changed
}
