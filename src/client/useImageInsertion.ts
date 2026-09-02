import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  AppCanvasMountStaleError,
  type AppCanvasMount,
} from './appCanvasMount'
import {
  createImageInsertionCanvas,
  imageInsertionError,
  insertImages,
  type ImageInsertionPlacement,
  type DraftImageInsertionPlacement,
  type ImageInsertionResult,
} from './imageInsertion'
import { compileEditorDraft } from './editorDraft'
import { ImageInsertionQueue, resolveDraftInsertionPlacement } from './imageInsertionQueue'

export function useImageInsertion(
  mountRef: MutableRefObject<AppCanvasMount | null>,
  projectId: string | null,
) {
  const [canvasError, setCanvasError] = useState<string | null>(null)
  const queueRef = useRef(new ImageInsertionQueue<AppCanvasMount>())

  useEffect(() => setCanvasError(null), [projectId])

  const insert = (
    mount: AppCanvasMount,
    files: Iterable<File>,
    placement: ImageInsertionPlacement,
  ) => queueRef.current.enqueue(mount, () =>
      mount.runCommand(({ projectId: activeProjectId, assertCurrent }) =>
        insertImages({
          canvas: createImageInsertionCanvas(mount.editor),
          projectId: activeProjectId,
          assertCurrent,
          resolveDraftPlacement: (draftPlacement) => resolveDraftInsertionPlacement(
            compileEditorDraft(mount.editor),
            draftPlacement,
          ),
        }, files, placement),
      ),
    )

  const insertCanvasImages = (
    mount: AppCanvasMount,
    files: Iterable<File>,
    point?: { x: number; y: number },
  ) => insert(mount, files, {
    kind: 'canvas',
    point: point ?? mount.editor.getViewportPageBounds().center,
    avoidObstacles: point === undefined,
  }).then((result) => {
    setCanvasError(imageInsertionError(result))
    return result
  }).catch((error) => {
    if (!(error instanceof AppCanvasMountStaleError)) {
      setCanvasError(error instanceof Error ? error.message : 'Images could not be added')
    }
    throw error
  })

  const insertDraftImages = (
    files: File[],
    placement: DraftImageInsertionPlacement,
  ): Promise<ImageInsertionResult> => {
    const mount = mountRef.current
    if (!mount) return Promise.reject(new Error('Canvas is not ready'))
    return insert(mount, files, placement)
  }

  const registerCanvasImageHandler = (mount: AppCanvasMount) => {
    mount.editor.registerExternalContentHandler('files', async ({ files, point }) => {
      if (!mount.initialized) {
        setCanvasError('Canvas is still loading')
        return
      }
      await insertCanvasImages(
        mount,
        files,
        point ? { x: point.x, y: point.y } : undefined,
      ).catch((error) => {
        if (!(error instanceof AppCanvasMountStaleError)) {
          console.error('Elves: dropped or pasted image command failed', error)
        }
      })
    })
  }

  return { canvasError, insertCanvasImages, insertDraftImages, registerCanvasImageHandler }
}
