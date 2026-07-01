import { Tldraw, Editor, getSnapshot, loadSnapshot } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil } from './shapes/CardShapeUtil'
import { loadCanvas, saveCanvas, debounce } from './client/persistence'

const shapeUtils = [CardShapeUtil]

export default function App() {
  const handleMount = (editor: Editor) => {
    // Load canvas snapshot, then wire up debounced save.
    loadCanvas()
      .then((snapshot) => {
        if (snapshot && snapshot.document) {
          loadSnapshot(editor.store, snapshot)
        }
      })
      .catch(() => {
        // No canvas yet — start empty. Not an error.
      })
      .finally(() => {
        const save = debounce(() => saveCanvas(getSnapshot(editor.store)), 500)
        editor.store.listen(save, { source: 'user', scope: 'document' })
      })
  }

  return (
    <div id="app-root">
      <Tldraw shapeUtils={shapeUtils} onMount={handleMount} />
    </div>
  )
}
