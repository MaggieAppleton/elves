import { expect, test } from 'vitest'
import type { DraftBlock } from '../../src/model/draft'
import {
  ImageInsertionQueue,
  resolveDraftInsertionPlacement,
} from '../../src/client/imageInsertionQueue'
import type { DraftImageInsertionPlacement } from '../../src/client/imageInsertion'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('concurrent commands resolve the same semantic gap against live draft order', async () => {
  const mount = {}
  const queue = new ImageInsertionQueue<object>()
  const gate = deferred()
  const ids = ['shape:before', 'shape:after']
  const placement: DraftImageInsertionPlacement = {
    kind: 'draft',
    sectionId: null,
    beforeId: 'shape:before',
    afterId: 'shape:after',
    fallbackPoint: { x: 0, y: 0 },
  }
  const blocks = (): DraftBlock[] => [{
    sectionId: null,
    section: null,
    authoredBy: null,
    items: ids.map((id) => ({ type: 'prose' as const, id, text: id })),
  }]

  const first = queue.enqueue(mount, async () => {
    const resolved = resolveDraftInsertionPlacement(blocks(), placement)
    await gate.promise
    ids.splice(resolved.index, 0, 'shape:image-1')
    return resolved.index
  })
  const second = queue.enqueue(mount, async () => {
    const resolved = resolveDraftInsertionPlacement(blocks(), placement)
    ids.splice(resolved.index, 0, 'shape:image-2')
    return resolved.index
  })

  gate.resolve()
  await expect(first).resolves.toBe(1)
  await expect(second).resolves.toBe(2)
  expect(ids).toEqual(['shape:before', 'shape:image-1', 'shape:image-2', 'shape:after'])
})
