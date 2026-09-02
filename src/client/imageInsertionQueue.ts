import type { DraftBlock } from '../model/draft'
import type {
  DraftImageInsertionPlacement,
  ResolvedDraftImageInsertionPlacement,
} from './imageInsertion'

/** Serializes commands per canvas mount without coupling unrelated mounts. */
export class ImageInsertionQueue<Mount extends object> {
  private readonly tails = new WeakMap<Mount, Promise<void>>()

  enqueue<T>(mount: Mount, run: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(mount) ?? Promise.resolve()
    const command = previous.catch(() => undefined).then(run)
    this.tails.set(mount, command.then(() => undefined, () => undefined))
    return command
  }
}

/** Resolve a user-chosen semantic gap against the draft at mutation time. */
export function resolveDraftInsertionPlacement(
  blocks: DraftBlock[],
  placement: DraftImageInsertionPlacement,
): ResolvedDraftImageInsertionPlacement {
  const block = blocks.find((candidate) => candidate.sectionId === placement.sectionId)
  const itemIds = block?.items.map((item) => item.id) ?? []
  const afterIndex = placement.afterId ? itemIds.indexOf(placement.afterId) : -1
  const beforeIndex = placement.beforeId ? itemIds.indexOf(placement.beforeId) : -1
  return {
    kind: 'draft',
    itemIds,
    index: afterIndex >= 0 ? afterIndex : beforeIndex >= 0 ? beforeIndex + 1 : itemIds.length,
    fallbackPoint: placement.fallbackPoint,
  }
}
