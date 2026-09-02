import { beforeEach, expect, test, vi } from 'vitest'
import type { TLParentId } from 'tldraw'
import {
  insertImages,
  type ImageInsertionCanvas,
  type ImageInsertionCard,
} from '../../src/client/imageInsertion'

const uploadAsset = vi.fn()
vi.mock('../../src/client/assets', () => ({
  uploadAsset: (projectId: string, file: File) => uploadAsset(projectId, file),
}))

const PAGE_ID = 'page:1' as TLParentId

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

interface TestShape {
  id: string
  parentId: TLParentId
  x: number
  y: number
  props: { w: number; h: number; assetId?: string }
}

function editorHarness() {
  const shapes: TestShape[] = []
  const parentOffsets = new Map<TLParentId, { x: number; y: number }>([
    [PAGE_ID, { x: 0, y: 0 }],
  ])
  const selected: string[][] = []
  let sequence = 0
  const offset = (parentId: TLParentId) => parentOffsets.get(parentId) ?? { x: 0, y: 0 }

  const canvas: ImageInsertionCanvas = {
    card(id): ImageInsertionCard | null {
      const shape = shapes.find((candidate) => candidate.id === id)
      if (!shape) return null
      const parent = offset(shape.parentId)
      return {
        id,
        parentId: shape.parentId,
        bounds: {
          x: shape.x + parent.x,
          y: shape.y + parent.y,
          w: shape.props.w,
          h: shape.props.h,
        },
      }
    },
    clearPosition: (rect) => rect,
    createImage({ assetId, size, pagePoint, parent }) {
      const parentId = parent?.parentId ?? PAGE_ID
      const parentOffset = offset(parentId)
      const id = `shape:image-${++sequence}`
      shapes.push({
        id,
        parentId,
        x: pagePoint.x - parentOffset.x,
        y: pagePoint.y - parentOffset.y,
        props: { ...size, assetId },
      })
      return id
    },
    moveCard(id, pagePoint) {
      const shape = shapes.find((candidate) => candidate.id === id)
      if (!shape) return
      const parent = offset(shape.parentId)
      shape.x = pagePoint.x - parent.x
      shape.y = pagePoint.y - parent.y
    },
    select(ids) { selected.push(ids) },
    transaction(run) { run() },
  }
  return { canvas, parentOffsets, selected, shapes }
}

beforeEach(() => {
  uploadAsset.mockReset()
  uploadAsset.mockImplementation(async (_projectId: string, file: File) => `${file.name}.stored`)
  vi.stubGlobal('createImageBitmap', async () => ({ width: 400, height: 200, close: vi.fn() }))
})

test('uploads supported images and stacks a canvas batch in source order', async () => {
  const { canvas, shapes } = editorHarness()
  const files = [
    new File(['a'], 'first.png', { type: 'image/png' }),
    new File(['b'], 'second.webp', { type: 'image/webp' }),
  ]

  const result = await insertImages(
    { canvas, projectId: 'essay', assertCurrent: vi.fn() },
    files,
    { kind: 'canvas', point: { x: 500, y: 300 }, avoidObstacles: false },
  )

  expect(result.failures).toEqual([])
  expect(result.createdIds).toHaveLength(2)
  expect(uploadAsset.mock.calls.map(([projectId, file]) => [projectId, file.name])).toEqual([
    ['essay', 'first.png'],
    ['essay', 'second.webp'],
  ])
  expect(shapes.map((shape) => ({
    assetId: shape.props.assetId,
    x: shape.x,
    y: shape.y,
    w: shape.props.w,
    h: shape.props.h,
  }))).toEqual([
    { assetId: 'first.png.stored', x: 360, y: 230, w: 280, h: 140 },
    { assetId: 'second.webp.stored', x: 360, y: 386, w: 280, h: 140 },
  ])
})

test('reports unsupported, empty, oversized, and failed files while keeping successful inserts', async () => {
  const { canvas } = editorHarness()
  const oversized = new File(['x'], 'huge.png', { type: 'image/png' })
  Object.defineProperty(oversized, 'size', { value: 25 * 1024 * 1024 + 1 })
  uploadAsset.mockRejectedValueOnce(new Error('network unavailable'))
  uploadAsset.mockResolvedValueOnce('good.png')

  const result = await insertImages(
    { canvas, projectId: 'essay', assertCurrent: vi.fn() },
    [
      new File(['text'], 'notes.txt', { type: 'text/plain' }),
      new File([], 'empty.png', { type: 'image/png' }),
      oversized,
      new File(['x'], 'failed.png', { type: 'image/png' }),
      new File(['x'], 'good.png', { type: 'image/png' }),
    ],
    { kind: 'canvas', point: { x: 200, y: 200 }, avoidObstacles: false },
  )

  expect(result.createdIds).toHaveLength(1)
  expect(result.failures).toEqual([
    { fileName: 'notes.txt', message: 'Unsupported image format' },
    { fileName: 'empty.png', message: 'Image is empty' },
    { fileName: 'huge.png', message: 'Image is larger than 25 MB' },
    { fileName: 'failed.png', message: 'network unavailable' },
  ])
})

test('inserts into a draft gap and shifts every later item in page order', async () => {
  const { canvas, parentOffsets, shapes } = editorHarness()
  const anchorParent = 'shape:anchor-parent' as TLParentId
  const laterParent = 'shape:later-parent' as TLParentId
  parentOffsets.set(anchorParent, { x: 100, y: 50 })
  parentOffsets.set(laterParent, { x: 200, y: 300 })
  shapes.push(
    {
      id: 'shape:before', parentId: anchorParent, x: -60, y: -30,
      props: { w: 240, h: 100 },
    },
    {
      id: 'shape:after', parentId: laterParent, x: -120, y: -164,
      props: { w: 240, h: 100 },
    },
  )

  await insertImages(
    { canvas, projectId: 'essay', assertCurrent: vi.fn() },
    [new File(['x'], 'middle.png', { type: 'image/png' })],
    {
      kind: 'draft', itemIds: ['shape:before', 'shape:after'], index: 1,
      fallbackPoint: { x: 500, y: 300 },
    },
  )

  const inserted = shapes.find((shape) => shape.props.assetId === 'middle.png.stored')
  expect(inserted).toMatchObject({ parentId: anchorParent, x: -80, y: 86 })
  expect(canvas.card(inserted!.id)?.bounds).toMatchObject({ x: 20, y: 136 })
  expect(shapes.find((shape) => shape.id === 'shape:after')?.y).toBe(-8)
  expect(canvas.card('shape:after')?.bounds.y).toBe(292)
})

test('keeps a draft image on the anchor centre so it remains in the same section band', async () => {
  const { canvas, shapes } = editorHarness()
  shapes.push({
    id: 'shape:anchor', parentId: PAGE_ID, x: 120, y: 20,
    props: { w: 370, h: 100 },
  })

  await insertImages(
    { canvas, projectId: 'essay', assertCurrent: vi.fn() },
    [new File(['x'], 'band.png', { type: 'image/png' })],
    {
      kind: 'draft', itemIds: ['shape:anchor'], index: 1,
      fallbackPoint: { x: 500, y: 300 },
    },
  )

  const inserted = shapes.find((shape) => shape.props.assetId === 'band.png.stored')
  if (!inserted) throw new Error('image was not inserted')
  expect(inserted.x + inserted.props.w / 2).toBe(120 + 370 / 2)
})

test('resolves a semantic draft gap after upload so intervening prose does not overlap', async () => {
  const { canvas, shapes } = editorHarness()
  shapes.push(
    { id: 'shape:before', parentId: PAGE_ID, x: 0, y: 20, props: { w: 280, h: 100 } },
    { id: 'shape:after', parentId: PAGE_ID, x: 0, y: 300, props: { w: 280, h: 100 } },
  )
  const upload = deferred<string>()
  uploadAsset.mockReturnValueOnce(upload.promise)

  const insertion = insertImages(
    {
      canvas,
      projectId: 'essay',
      assertCurrent: vi.fn(),
      resolveDraftPlacement: (placement) => {
        const itemIds = [...shapes]
          .filter((shape) => !shape.props.assetId)
          .sort((a, b) => a.y - b.y)
          .map((shape) => shape.id)
        return {
          kind: 'draft',
          itemIds,
          index: placement.afterId ? itemIds.indexOf(placement.afterId) : itemIds.length,
          fallbackPoint: placement.fallbackPoint,
        }
      },
    },
    [new File(['x'], 'delayed.png', { type: 'image/png' })],
    {
      kind: 'draft',
      sectionId: null,
      beforeId: 'shape:before',
      afterId: 'shape:after',
      fallbackPoint: { x: 500, y: 300 },
    },
  )
  await vi.waitFor(() => expect(uploadAsset).toHaveBeenCalledOnce())
  shapes.push({
    id: 'shape:split', parentId: PAGE_ID, x: 0, y: 136,
    props: { w: 280, h: 100 },
  })
  upload.resolve('delayed.png.stored')
  await insertion

  const inserted = shapes.find((shape) => shape.props.assetId === 'delayed.png.stored')
  expect(inserted?.y).toBe(252)
  expect(shapes.find((shape) => shape.id === 'shape:after')?.y).toBe(456)
})

test('aborts the remaining batch when the project mount becomes stale', async () => {
  const { canvas } = editorHarness()
  let checks = 0
  const assertCurrent = vi.fn(() => {
    checks += 1
    if (checks === 4) throw new Error('stale mount')
  })

  await expect(insertImages(
    { canvas, projectId: 'essay', assertCurrent },
    [
      new File(['x'], 'first.png', { type: 'image/png' }),
      new File(['x'], 'second.png', { type: 'image/png' }),
    ],
    { kind: 'canvas', point: { x: 200, y: 200 }, avoidObstacles: false },
  )).rejects.toThrow('stale mount')
  expect(uploadAsset).toHaveBeenCalledTimes(1)
})
