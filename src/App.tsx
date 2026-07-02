import { useRef, useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { makeProseCardProps, makeSourceCardProps, makeImageSourceCardProps } from './model/cards'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'
import { uploadAsset } from './client/assets'
import { applyChangeSet } from './apply/applyChangeSet'
import { connectRealtime } from './client/realtime'

const shapeUtils = [CardShapeUtil]

// Phosphor "Plus" (regular weight), inlined to avoid pulling in the whole icon package.
function PlusIcon() {
  return (
    <svg className="elves-btn-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
    </svg>
  )
}

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showTools, setShowTools] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addImageCard = async (ed: Editor, file: File, point?: { x: number; y: number }) => {
    let aspect = 0.7
    try {
      const bmp = await createImageBitmap(file)
      if (bmp.width > 0) aspect = bmp.height / bmp.width
      bmp.close?.()
    } catch { /* keep default aspect */ }
    const w = 280
    const h = Math.max(80, Math.round(w * aspect))
    const assetId = await uploadAsset(file)
    const at = point ?? ed.getViewportPageBounds().center
    const id = createShapeId()
    ed.createShape<CardShape>({
      id, type: 'card', x: at.x - w / 2, y: at.y - h / 2,
      props: { ...makeImageSourceCardProps(assetId), w, h },
    })
    ed.select(id)
  }

  const handleMount = (ed: Editor) => {
    setEditor(ed)
    loadCanvas()
      .then((snapshot) => {
        if (snapshot?.document) loadSnapshot(ed.store, snapshot)
      })
      .catch((err) => console.error('Elves: canvas load failed, starting empty', err))
      .finally(() => {
        let saving = false
        const doSave = () => {
          if (saving) return
          saving = true
          saveCanvas(getSnapshot(ed.store))
            .catch((err) => console.error('Elves: canvas save failed', err))
            .finally(() => { saving = false })
        }
        const save = debounce(doSave, 500)
        ed.store.listen(save, { source: 'user', scope: 'document' })
        connectRealtime((cs) => { applyChangeSet(ed, cs); setTimeout(doSave, 0) })
        ed.registerExternalContentHandler('files', async ({ files, point }) => {
          for (const file of files) {
            if (file.type.startsWith('image/')) await addImageCard(ed, file, point)
          }
        })
      })
  }

  const addCard = (kind: 'prose' | 'source') => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props = kind === 'prose' ? makeProseCardProps() : makeSourceCardProps()
    const id = createShapeId()
    editor.createShape<CardShape>({
      id, type: 'card',
      x: center.x - props.w / 2, y: center.y - props.h / 2,
      props,
    })
    editor.select(id)
  }

  return (
    <div id="app-root" className={showTools ? undefined : 'elves-hide-tools'}>
      <button
        className="elves-tools-toggle"
        data-active={showTools}
        title="Show/hide drawing tools"
        onClick={() => setShowTools((v) => !v)}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
        </svg>
      </button>
      <div className="elves-toolbar">
        <button data-testid="new-prose" onClick={() => addCard('prose')}><PlusIcon />Prose</button>
        <button data-testid="new-source" onClick={() => addCard('source')}><PlusIcon />Notes</button>
        <button data-testid="new-image" onClick={() => fileInputRef.current?.click()}><PlusIcon />Image</button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          data-testid="image-input"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && editor) addImageCard(editor, file)
            e.target.value = ''
          }}
        />
      </div>
      <Tldraw shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
