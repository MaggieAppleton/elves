import { useEffect, useRef, useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { cardIsHidden, collapseAll } from './shapes/mergeView'
import { SectionShapeUtil, SectionShape } from './shapes/SectionShapeUtil'
import {
  makeProseCardProps, makeSourceCardProps, makeImageSourceCardProps, makeReferenceCardProps,
} from './model/cards'
import { makeSectionProps } from './model/sections'
import { requestUnfurl } from './client/references'
import {
  loadCanvas,
  saveCanvas,
  debounce,
  listProjects,
  createProject,
  renameProject,
  type Project,
} from './client/persistence'
import { uploadAsset, setAssetProject } from './client/assets'
import { applyChangeSet } from './apply/applyChangeSet'
import { connectRealtime } from './client/realtime'
import { ProjectSwitcher } from './components/ProjectSwitcher'

const shapeUtils = [CardShapeUtil, SectionShapeUtil]

// Cards merged away into a representative are kept for recovery but must not
// render as their own shape — hidden here from BOTH rendering and hit-testing so
// they can't become invisible-yet-selectable "ghosts". The representative shows
// them (a stack + an on-demand fan-out).
const getShapeVisibility = (shape: Parameters<typeof cardIsHidden>[0]) =>
  cardIsHidden(shape) ? ('hidden' as const) : ('inherit' as const)
const LAST_PROJECT_KEY = 'elves:lastProject'

// Phosphor "Plus" (regular weight), inlined to avoid pulling in the whole icon package.
function PlusIcon() {
  return (
    <svg className="elves-btn-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
    </svg>
  )
}

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null) // null = still loading
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showTools, setShowTools] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const projectIdRef = useRef<string | null>(null)

  // Keep the refs + the asset base in sync during render so they are correct the
  // instant tldraw's onMount fires and whenever a card image renders.
  projectIdRef.current = currentProjectId
  setAssetProject(currentProjectId)

  // Load the project list once; open the last-used project (or the first).
  useEffect(() => {
    listProjects()
      .then((list) => {
        setProjects(list)
        if (list.length) {
          const last = localStorage.getItem(LAST_PROJECT_KEY)
          setCurrentProjectId(list.some((p) => p.id === last) ? last : list[0].id)
        }
      })
      .catch((err) => {
        console.error('Elves: failed to load projects', err)
        setProjects([])
      })
  }, [])

  // One realtime connection for the app's lifetime. Apply a change-set only when
  // it targets the project currently open (refs stay current across switches).
  useEffect(
    () =>
      connectRealtime((projectId, cs) => {
        if (projectId !== projectIdRef.current) return
        const ed = editorRef.current
        if (!ed) return
        applyChangeSet(ed, cs)
        saveCanvas(projectId, getSnapshot(ed.store)).catch((err) =>
          console.error('Elves: canvas save failed', err),
        )
      }),
    [],
  )

  const addImageCard = async (ed: Editor, file: File, point?: { x: number; y: number }) => {
    const pid = projectIdRef.current
    if (!pid) return
    let aspect = 0.7
    try {
      const bmp = await createImageBitmap(file)
      if (bmp.width > 0) aspect = bmp.height / bmp.width
      bmp.close?.()
    } catch {
      /* keep default aspect */
    }
    const w = 280
    const h = Math.max(80, Math.round(w * aspect))
    const assetId = await uploadAsset(pid, file)
    const at = point ?? ed.getViewportPageBounds().center
    const id = createShapeId()
    ed.createShape<CardShape>({
      id,
      type: 'card',
      x: at.x - w / 2,
      y: at.y - h / 2,
      props: { ...makeImageSourceCardProps(assetId), w, h },
    })
    ed.select(id)
  }

  // Turn a url into a reference card: unfurl it (title/site/favicon/hero, cached
  // as local assets) and drop the type-adaptive card at the given point.
  const addReferenceFromUrl = async (ed: Editor, url: string, point?: { x: number; y: number }) => {
    const pid = projectIdRef.current
    if (!pid) return
    const reference = await requestUnfurl(pid, url)
    const props = makeReferenceCardProps(reference)
    const at = point ?? ed.getViewportPageBounds().center
    const id = createShapeId()
    ed.createShape<CardShape>({ id, type: 'card', x: at.x - props.w / 2, y: at.y - props.h / 2, props })
    ed.select(id)
  }

  const handleMount = (ed: Editor) => {
    editorRef.current = ed
    setEditor(ed)
    // A click on empty canvas dismisses any open merged-card peek, like a popover.
    ed.on('event', (info) => {
      if (info.name === 'pointer_down' && info.target === 'canvas') collapseAll()
    })
    const pid = projectIdRef.current
    if (!pid) return
    loadCanvas(pid)
      .then((snapshot) => {
        if (snapshot?.document) loadSnapshot(ed.store, snapshot)
      })
      .catch((err) => console.error('Elves: canvas load failed, starting empty', err))
      .finally(() => {
        let saving = false
        const doSave = () => {
          if (saving) return
          saving = true
          saveCanvas(pid, getSnapshot(ed.store))
            .catch((err) => console.error('Elves: canvas save failed', err))
            .finally(() => {
              saving = false
            })
        }
        const save = debounce(doSave, 500)
        ed.store.listen(save, { source: 'user', scope: 'document' })
        ed.registerExternalContentHandler('files', async ({ files, point }) => {
          for (const file of files) {
            if (file.type.startsWith('image/')) await addImageCard(ed, file, point)
          }
        })
        // Pasting or dropping a URL becomes a reference card (instead of tldraw's
        // default bookmark shape).
        ed.registerExternalContentHandler('url', async ({ url, point }) => {
          await addReferenceFromUrl(ed, url, point)
        })
      })
  }

  const addCard = (kind: 'prose' | 'source') => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props = kind === 'prose' ? makeProseCardProps() : makeSourceCardProps()
    const id = createShapeId()
    editor.createShape<CardShape>({
      id,
      type: 'card',
      x: center.x - props.w / 2,
      y: center.y - props.h / 2,
      props,
    })
    editor.select(id)
  }

  const addSection = () => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props = makeSectionProps()
    const id = createShapeId()
    editor.createShape<SectionShape>({
      id,
      type: 'section',
      x: center.x - props.w / 2,
      y: center.y - props.h / 2,
      props,
    })
    editor.select(id)
    editor.setEditingShape(id)
  }

  const addLinkFlow = async () => {
    if (!editor) return
    const raw = window.prompt('Paste a link to add as a reference')?.trim()
    if (!raw) return
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    await addReferenceFromUrl(editor, url)
  }

  const switchProject = async (id: string) => {
    if (id === currentProjectId) return
    // Flush the outgoing project's latest edits before the editor unmounts.
    const ed = editorRef.current
    if (ed && currentProjectId) {
      try {
        await saveCanvas(currentProjectId, getSnapshot(ed.store))
      } catch (err) {
        console.error('Elves: canvas save failed', err)
      }
    }
    localStorage.setItem(LAST_PROJECT_KEY, id)
    setCurrentProjectId(id)
  }

  const createFlow = async () => {
    const name = window.prompt('New project name')?.trim()
    if (!name) return
    try {
      const proj = await createProject(name)
      setProjects(await listProjects())
      await switchProject(proj.id)
    } catch (err) {
      console.error('Elves: failed to create project', err)
    }
  }

  const renameFlow = async () => {
    if (!currentProjectId) return
    const cur = projects?.find((p) => p.id === currentProjectId)
    const name = window.prompt('Rename project', cur?.name ?? '')?.trim()
    if (!name) return
    try {
      await renameProject(currentProjectId, name)
      setProjects(await listProjects())
    } catch (err) {
      console.error('Elves: failed to rename project', err)
    }
  }

  // Still loading the project list.
  if (projects === null) return <div id="app-root" />

  // No projects yet — invite the user to create their first.
  if (projects.length === 0) {
    return (
      <div id="app-root">
        <div className="elves-empty">
          <h1 className="elves-empty__title">No projects yet</h1>
          <p className="elves-empty__body">Create your first writing project to start a canvas.</p>
          <button className="elves-empty__button" data-testid="project-new" onClick={createFlow}>
            <PlusIcon />
            New project
          </button>
        </div>
      </div>
    )
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
      <ProjectSwitcher
        projects={projects}
        currentId={currentProjectId}
        onSwitch={switchProject}
        onCreate={createFlow}
        onRename={renameFlow}
      />
      <div className="elves-toolbar">
        <button data-testid="new-prose" onClick={() => addCard('prose')}><PlusIcon />Prose</button>
        <button data-testid="new-source" onClick={() => addCard('source')}><PlusIcon />Notes</button>
        <button data-testid="new-image" onClick={() => fileInputRef.current?.click()}><PlusIcon />Image</button>
        <button data-testid="new-link" onClick={addLinkFlow}><PlusIcon />Link</button>
        <button data-testid="new-section" onClick={addSection}><PlusIcon />Section</button>
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
      <Tldraw
        key={currentProjectId ?? 'none'}
        shapeUtils={shapeUtils}
        getShapeVisibility={getShapeVisibility}
        onMount={handleMount}
      />
    </div>
  )
}
