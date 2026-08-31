import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type FocusEvent } from 'react'
import type { Editor } from 'tldraw'
import type { DraftBlock } from '../model/draft'
import {
  imageInsertionError,
  type DraftImageInsertionPlacement,
  type ImageInsertionResult,
} from '../client/imageInsertion'

export type DraftImageInserter = (
  files: File[],
  placement: DraftImageInsertionPlacement,
) => Promise<ImageInsertionResult>

const emptyBlock = (): DraftBlock => ({
  sectionId: null,
  section: null,
  authoredBy: null,
  items: [],
})

function nearestDropGap(container: HTMLElement, clientY: number) {
  let nearest: { blockIndex: number; index: number; distance: number } | null = null
  for (const gap of container.querySelectorAll<HTMLElement>('[data-draft-gap]')) {
    const rect = gap.getBoundingClientRect()
    const distance = Math.abs(clientY - (rect.top + rect.height / 2))
    if (nearest && nearest.distance <= distance) continue
    nearest = {
      blockIndex: Number(gap.dataset.blockIndex),
      index: Number(gap.dataset.index),
      distance,
    }
  }
  return nearest && { blockIndex: nearest.blockIndex, index: nearest.index }
}

export function useDraftImageInsertion({
  blocks,
  editor,
  readOnly,
  onInsertImages,
}: {
  blocks: DraftBlock[]
  editor: Editor | null
  readOnly: boolean
  onInsertImages?: DraftImageInserter
}) {
  const focusedProseIdRef = useRef<string | null>(null)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const requestRef = useRef(0)
  const [imageError, setImageError] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ blockIndex: number; index: number } | null>(null)

  useEffect(() => {
    requestRef.current += 1
    setImageError(null)
    if (readOnly) setDropTarget(null)
  }, [editor, readOnly])

  const insert = async (files: File[], block: DraftBlock, index: number) => {
    if (!editor || !onInsertImages || readOnly) return
    const request = ++requestRef.current
    const requestEditor = editor
    try {
      const result = await onInsertImages(files, {
        kind: 'draft',
        sectionId: block.sectionId,
        beforeId: block.items[index - 1]?.id ?? null,
        afterId: block.items[index]?.id ?? null,
        fallbackPoint: editor.getViewportPageBounds().center,
      })
      if (request !== requestRef.current || requestEditor !== editorRef.current) return
      setImageError(imageInsertionError(result))
    } catch (error) {
      if (request !== requestRef.current || requestEditor !== editorRef.current) return
      setImageError(error instanceof Error ? error.message : 'Images could not be added')
    }
  }

  const onPasteCapture = (event: ClipboardEvent<HTMLDivElement>) => {
    if (readOnly || !onInsertImages) return
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== 'file') continue
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length === 0) return
    event.preventDefault()
    event.stopPropagation()

    const focusedId = focusedProseIdRef.current
    const focusedBlock = focusedId
      ? blocks.find((block) => block.items.some((item) => item.id === focusedId))
      : undefined
    const block = focusedBlock ?? blocks.at(-1) ?? emptyBlock()
    const focusedIndex = focusedId
      ? block.items.findIndex((item) => item.id === focusedId)
      : -1
    void insert(images, block, focusedIndex >= 0 ? focusedIndex + 1 : block.items.length)
  }

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || !onInsertImages || !Array.from(event.dataTransfer.types).includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDropTarget(nearestDropGap(event.currentTarget, event.clientY))
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (readOnly || !onInsertImages) return
    const isFileDrop = Array.from(event.dataTransfer.types).includes('Files')
    if (!isFileDrop) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) {
      setDropTarget(null)
      return
    }
    const target = dropTarget ?? nearestDropGap(event.currentTarget, event.clientY) ?? {
      blockIndex: Math.max(0, blocks.length - 1),
      index: blocks.at(-1)?.items.length ?? 0,
    }
    setDropTarget(null)
    void insert(files, blocks[target.blockIndex] ?? emptyBlock(), target.index)
  }

  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-draft-prose-id]')
    focusedProseIdRef.current = row?.dataset.draftProseId ?? null
  }

  const onBlurCapture = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (!(next instanceof Element) || !next.closest('[data-draft-prose-id]')) {
      focusedProseIdRef.current = null
    }
  }

  return {
    imageError,
    dropTarget,
    onPasteCapture,
    onFocusCapture,
    onBlurCapture,
    onDragOver,
    onDrop,
    clearDropTarget: () => setDropTarget(null),
  }
}
