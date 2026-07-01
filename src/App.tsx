import { useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { makeProseCardProps, makeSourceCardProps } from './model/cards'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'
import { applyChangeSet } from './apply/applyChangeSet'
import { connectRealtime } from './client/realtime'

const shapeUtils = [CardShapeUtil]

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null)

  const handleMount = (ed: Editor) => {
    setEditor(ed)
    loadCanvas()
      .then((snapshot) => {
        if (snapshot?.document) loadSnapshot(ed.store, snapshot)
      })
      .catch((err) => console.error('Elves: canvas load failed, starting empty', err))
      .finally(() => {
        const save = debounce(() => {
          saveCanvas(getSnapshot(ed.store)).catch((err) =>
            console.error('Elves: canvas save failed', err),
          )
        }, 500)
        ed.store.listen(save, { source: 'user', scope: 'document' })
        connectRealtime((cs) => applyChangeSet(ed, cs))
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
    <div id="app-root">
      <div className="elves-toolbar">
        <button data-testid="new-prose" onClick={() => addCard('prose')}>+ Prose</button>
        <button data-testid="new-source" onClick={() => addCard('source')}>+ Source</button>
      </div>
      <Tldraw shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
