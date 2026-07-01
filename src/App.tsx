import { useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { makeProseCardProps, makeSourceCardProps } from './model/cards'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'

const shapeUtils = [CardShapeUtil]

export default function App() {
  const [editor, setEditor] = useState<Editor | null>(null)

  const handleMount = async (ed: Editor) => {
    setEditor(ed)
    const snapshot = await loadCanvas()
    if (snapshot && snapshot.document) loadSnapshot(ed.store, snapshot)
    const save = debounce(() => saveCanvas(getSnapshot(ed.store)), 500)
    ed.store.listen(save, { source: 'user', scope: 'document' })
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
