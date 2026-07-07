import { useEffect, useRef, useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId } from 'tldraw'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { cardIsHidden, collapseAll } from './shapes/mergeView'
import { SectionShapeUtil, SectionShape } from './shapes/SectionShapeUtil'
import { QuestionShapeUtil } from './shapes/QuestionShapeUtil'
import {
  makeProseCardProps, makeNoteCardProps, makeImageNoteCardProps, makeReferenceCardProps,
  makeFigureCardProps,
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
import type { ChangeSet } from './model/changeset'
import { connectRealtime } from './client/realtime'
import { markDoing, markLooking, clearPresence } from './client/presence'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { DraftPane } from './components/DraftPane'
import { DraftDrawerControls } from './components/DraftDrawerControls'
import { type ViewState, moreDraft, lessDraft } from './client/viewMachine'

const shapeUtils = [CardShapeUtil, SectionShapeUtil, QuestionShapeUtil]

// A dismissed question is answered/waved off: hidden from render AND hit-testing
// (so it can't linger as an invisible-yet-selectable ghost), but kept in the
// file so it stays recoverable and Claude still sees it in read_map.
const questionIsHidden = (shape: { type: string; props: { dismissed?: boolean } }) =>
  shape.type === 'question' && !!shape.props.dismissed

// Cards merged away into a representative are kept for recovery but must not
// render as their own shape — hidden here from BOTH rendering and hit-testing so
// they can't become invisible-yet-selectable "ghosts". The representative shows
// them (a stack + an on-demand fan-out). Dismissed questions hide the same way.
const getShapeVisibility = (shape: Parameters<typeof cardIsHidden>[0]) =>
  cardIsHidden(shape) || questionIsHidden(shape as { type: string; props: { dismissed?: boolean } })
    ? ('hidden' as const)
    : ('inherit' as const)
const LAST_PROJECT_KEY = 'elves:lastProject'
// View state (canvas / split / draft) and the split divider ratio persist PER
// project, so each piece reopens the way you left it reading it.
const viewKey = (id: string) => `elves:view:${id}`
const splitKey = (id: string) => `elves:split:${id}`

// A rename can change a project's id (the server re-slugs the folder to match the
// new name). Carry the per-project browser state over to the new id so view/split
// survive the rename instead of resetting.
function migrateProjectLocalStorage(oldId: string, newId: string) {
  for (const key of [viewKey, splitKey]) {
    const v = localStorage.getItem(key(oldId))
    if (v !== null) {
      localStorage.setItem(key(newId), v)
      localStorage.removeItem(key(oldId))
    }
  }
}
const DEFAULT_SPLIT = 0.6 // canvas gets 60% in split by default
const MIN_SPLIT = 0.18
const MAX_SPLIT = 0.82

// Phosphor "Plus" (regular weight), inlined to avoid pulling in the whole icon package.
function PlusIcon() {
  return (
    <svg className="elves-btn-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
      <path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z" />
    </svg>
  )
}

// Apply a change-set to the loaded store and persist the result. Shared by the
// live realtime handler and the post-load catch-up, so a change-set replayed
// after the canvas finishes loading behaves exactly like one applied live —
// same document edit, same "doing" glow, same save.
function applyAndPersist(ed: Editor, projectId: string, cs: ChangeSet) {
  const affected = applyChangeSet(ed, cs)
  // Glow the cards the agent just acted on ("doing"). Summary reconciles are
  // background machine work, not the agent working — skip them so the board
  // doesn't flicker orange every time a gist settles.
  if (cs.ops.some((op) => op.kind !== 'set_summary')) markDoing(affected)
  saveCanvas(projectId, getSnapshot(ed.store)).catch((err) =>
    console.error('Elves: canvas save failed', err),
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
  // False until the open project's canvas has loaded from disk. Every save path
  // checks this so a failed (or not-yet-finished) load can't serialize an empty
  // store over real on-disk data.
  const canvasLoadedRef = useRef(false)
  // Change-sets that arrive in the window between the canvas element mounting and
  // its document finishing loading can't be applied yet — doing so and saving
  // would clobber the real on-disk document (see the realtime handler). Rather
  // than drop them and lose the agent's action, buffer them here, tagged with
  // their target project, and reconcile once the load resolves.
  const pendingChangeSetsRef = useRef<{ projectId: string; cs: ChangeSet }[]>([])

  // Three view states — canvas only, split, draft only — plus the split ratio
  // (canvas fraction). tldraw stays MOUNTED in all three; draft-only just
  // collapses its pane width to 0, so the store, persistence, and realtime never
  // tear down. Both persist per project (loaded on switch, below).
  const [view, setView] = useState<ViewState>('canvas')
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

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
      connectRealtime(
        (projectId, cs) => {
          if (projectId !== projectIdRef.current) return
          const ed = editorRef.current
          if (!ed) return
          // The canvas hasn't finished loading. Applying now — onto a not-yet-
          // loaded store — then saving would clobber the real document on disk.
          // But silently dropping the change-set loses the agent's action for
          // this page session (and for a brand-new project it may never have been
          // persisted server-side, so a reload wouldn't recover it either).
          // Buffer it; handleMount reconciles the buffer once the load resolves.
          if (!canvasLoadedRef.current) {
            pendingChangeSetsRef.current.push({ projectId, cs })
            return
          }
          applyAndPersist(ed, projectId, cs)
        },
        (projectId, presence) => {
          // The agent is "looking" at these cards (read_cards). Ephemeral: no
          // document change, no save — just a glow on cards that actually exist
          // in the open project.
          if (projectId !== projectIdRef.current) return
          const ed = editorRef.current
          if (!ed) return
          const present = presence.cardIds.filter((id) => ed.getShape(id as CardShape['id']))
          markLooking(present as CardShape['id'][])
        },
      ),
    [],
  )

  // Presence is keyed by shape id; dropping it on project switch is cheap
  // insurance against a stale glow lingering as a new project's cards mount.
  useEffect(() => {
    clearPresence()
  }, [currentProjectId])

  // Restore this project's saved view + split ratio when it opens.
  useEffect(() => {
    if (!currentProjectId) return
    const savedView = localStorage.getItem(viewKey(currentProjectId))
    setView(savedView === 'split' || savedView === 'draft' ? savedView : 'canvas')
    const savedSplit = parseFloat(localStorage.getItem(splitKey(currentProjectId)) ?? '')
    setSplit(
      Number.isFinite(savedSplit) && savedSplit >= MIN_SPLIT && savedSplit <= MAX_SPLIT
        ? savedSplit
        : DEFAULT_SPLIT,
    )
  }, [currentProjectId])

  const changeView = (next: ViewState) => {
    setView(next)
    if (projectIdRef.current) localStorage.setItem(viewKey(projectIdRef.current), next)
  }

  // The drawer moves one step at a time: « widens toward draft, » narrows
  // toward canvas. Both clamp at the ends of the sequence.
  const expandDraft = () => changeView(moreDraft(view))
  const collapseDraft = () => changeView(lessDraft(view))

  // Persist the split ratio as it changes (also harmlessly re-writes the restored
  // value on open — same key, same number).
  useEffect(() => {
    if (currentProjectId) localStorage.setItem(splitKey(currentProjectId), String(split))
  }, [split, currentProjectId])

  // Keyboard: ⌘/Ctrl + \ widens the drawer (more draft); add Shift to narrow it
  // (less draft). A modifier is required so it never fights typing in a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') {
        e.preventDefault()
        changeView(e.shiftKey ? lessDraft(view) : moreDraft(view))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  // Drag the split divider to set the canvas/draft ratio. Pointer events are
  // captured on window so a fast drag off the handle keeps tracking; transitions
  // are suspended (via the stage's data-dragging flag) so the panes follow the
  // cursor 1:1 instead of easing behind it.
  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const stage = stageRef.current
    if (!stage) return
    setDragging(true)
    const onMove = (ev: PointerEvent) => {
      const rect = stage.getBoundingClientRect()
      if (rect.width === 0) return
      const r = (ev.clientX - rect.left) / rect.width
      setSplit(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, r)))
    }
    const onUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Draft → canvas navigation: pan (keeping zoom) to a clicked paragraph's card
  // and select it. From draft-only we first open split so the canvas is visible,
  // then pan once the pane has finished widening.
  const focusCard = (cardId: string) => {
    const ed = editorRef.current
    if (!ed) return
    const id = cardId as CardShape['id']
    const bounds = ed.getShapePageBounds(id)
    if (!bounds) return
    ed.select(id)
    ed.centerOnPoint(bounds.center, { animation: { duration: 300 } })
  }

  const onSelectCard = (cardId: string) => {
    if (view === 'draft') {
      changeView('split')
      setTimeout(() => focusCard(cardId), 340) // after the width transition settles
    } else {
      focusCard(cardId)
    }
  }

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
      props: { ...makeImageNoteCardProps(assetId), w, h },
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

  // Once the canvas has loaded, reconcile any change-sets that arrived — and were
  // buffered — while it was still loading. Re-fetch once to tell two cases apart:
  //  • The server persisted them (a project that already has a document): the
  //    re-fetched snapshot is authoritative and already includes them, so reload
  //    it rather than replay — replaying would mint duplicate cards, since create
  //    ops assign fresh shape ids with nothing to dedupe against.
  //  • The server only broadcast them (a brand-new project with no document yet —
  //    it won't synthesise a tldraw schema server-side): nothing was persisted,
  //    so replay the buffered ops to materialise them; the save then writes the
  //    now-real document to disk.
  const reconcilePendingChangeSets = async (ed: Editor, pid: string) => {
    const queued = pendingChangeSetsRef.current.filter((e) => e.projectId === pid)
    // Reset unconditionally: anything not for `pid` is a straggler from a project
    // whose load never finished, and can't belong to the canvas mounting now.
    pendingChangeSetsRef.current = []
    if (!queued.length) return
    let fresh: any = null
    try {
      fresh = await loadCanvas(pid)
    } catch (err) {
      console.error('Elves: resync fetch after load failed; replaying buffered change-sets', err)
    }
    // A project switch may have unmounted this editor while we were fetching.
    if (projectIdRef.current !== pid || editorRef.current !== ed) return
    if (fresh?.document) {
      loadSnapshot(ed.store, fresh)
      return
    }
    for (const { cs } of queued) applyAndPersist(ed, pid, cs)
  }

  const handleMount = (ed: Editor) => {
    editorRef.current = ed
    setEditor(ed)
    // A fresh mount hasn't loaded its canvas yet — hold off every save path.
    canvasLoadedRef.current = false
    // A click on empty canvas dismisses any open merged-card peek, like a popover.
    ed.on('event', (info) => {
      if (info.name === 'pointer_down' && info.target === 'canvas') collapseAll()
    })
    // Foreclose rotating the native `group` shape (issue #39). card/section utils
    // veto their own rotation, but grouped cards can be rotated via the GROUP's
    // handle/action — and `group` is a tldraw core shape that cannot be overridden
    // with a custom util (checkShapesAndAddCore throws). A rotated group ancestor
    // reintroduces the very client/server reading-order divergence this issue
    // closes: server/digest.ts resolvePageXY walks parent x/y additively with no
    // rotation matrix. So we clamp any group back to rotation 0 in the store — the
    // one place every rotate path (drag handle AND the rotate-90 actions) funnels
    // through. Reverting x/y too keeps the group from orbiting its pivot as it's
    // held un-rotated.
    ed.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
      if (next.type === 'group' && next.rotation !== 0) {
        return { ...next, rotation: 0, x: prev.x, y: prev.y }
      }
      return next
    })
    const pid = projectIdRef.current
    if (!pid) return
    loadCanvas(pid)
      .then((snapshot) => {
        if (snapshot?.document) loadSnapshot(ed.store, snapshot)
        // Load succeeded — an empty-but-new project counts, since its file is
        // legitimately empty. Only now is it safe to persist: wiring the save
        // paths here (not in a .finally that also runs on failure) means a
        // failed load leaves the canvas read-through and never overwrites disk.
        canvasLoadedRef.current = true
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
        // Catch up on anything the agent did while the canvas was still loading.
        void reconcilePendingChangeSets(ed, pid)
      })
      .catch((err) => {
        // Load failed — persistence stays disabled to protect on-disk data, and
        // buffered change-sets can't be safely applied onto an unloaded store, so
        // drop this project's rather than let them accumulate.
        pendingChangeSetsRef.current = pendingChangeSetsRef.current.filter(
          (e) => e.projectId !== pid,
        )
        console.error(
          'Elves: canvas load failed — persistence disabled to protect on-disk data',
          err,
        )
      })
  }

  const addCard = (kind: 'prose' | 'note' | 'figure') => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props =
      kind === 'prose' ? makeProseCardProps()
      : kind === 'figure' ? makeFigureCardProps()
      : makeNoteCardProps()
    const id = createShapeId()
    editor.createShape<CardShape>({
      id,
      type: 'card',
      x: center.x - props.w / 2,
      y: center.y - props.h / 2,
      props,
    })
    editor.select(id)
    // A figure is born blank — drop straight into editing so the title/description
    // fields are ready to type, the way a new section opens its editor.
    if (kind === 'figure') editor.setEditingShape(id)
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

  const addReferenceFlow = async () => {
    if (!editor) return
    const raw = window.prompt('Paste a link to add as a reference')?.trim()
    if (!raw) return
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    await addReferenceFromUrl(editor, url)
  }

  const switchProject = async (id: string) => {
    if (id === currentProjectId) return
    // Flush the outgoing project's latest edits before the editor unmounts —
    // but only if it actually loaded, else we'd flush an empty store over it.
    const ed = editorRef.current
    if (ed && currentProjectId && canvasLoadedRef.current) {
      try {
        await saveCanvas(currentProjectId, getSnapshot(ed.store))
      } catch (err) {
        console.error('Elves: canvas save failed', err)
      }
    }
    // Close the window between changing project and the new canvas mounting:
    // no save path should fire against the old store under the new project id.
    canvasLoadedRef.current = false
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
      const oldId = currentProjectId
      const updated = await renameProject(oldId, name)
      setProjects(await listProjects())
      // The server re-slugs the folder to match the new name, so the id may have
      // changed. Re-point the app at it: carry the browser state over, flush the
      // live store to the new location (covering edits still inside the save
      // debounce — the server already moved canvas.json there), and open the new
      // id, which remounts the canvas and re-targets realtime via projectIdRef.
      if (updated.id !== oldId) {
        migrateProjectLocalStorage(oldId, updated.id)
        const ed = editorRef.current
        if (ed && canvasLoadedRef.current) {
          try {
            await saveCanvas(updated.id, getSnapshot(ed.store))
          } catch (err) {
            console.error('Elves: canvas save after rename failed', err)
          }
        }
        canvasLoadedRef.current = false
        localStorage.setItem(LAST_PROJECT_KEY, updated.id)
        setCurrentProjectId(updated.id)
      }
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

  // Pane widths for the three states. tldraw stays mounted; draft-only just
  // collapses the canvas pane to 0 (and vice-versa), and CSS transitions the
  // width so moving between states feels continuous rather than modal.
  const canvasWidth = view === 'canvas' ? '100%' : view === 'draft' ? '0%' : `${split * 100}%`
  const draftWidth = view === 'canvas' ? '0%' : view === 'draft' ? '100%' : `${(1 - split) * 100}%`

  return (
    <div id="app-root" className={showTools ? undefined : 'elves-hide-tools'}>
      {/* Canvas-editing chrome is only meaningful when the canvas is visible. */}
      {view !== 'draft' && (
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
      )}
      <div className="elves-topbar">
        {view !== 'draft' && (
          <div className="elves-toolbar">
            <button data-testid="new-prose" onClick={() => addCard('prose')}><PlusIcon />Prose</button>
            <button data-testid="new-note" onClick={() => addCard('note')}><PlusIcon />Notes</button>
            <button data-testid="new-image" onClick={() => fileInputRef.current?.click()}><PlusIcon />Image</button>
            <button data-testid="new-reference" onClick={addReferenceFlow}><PlusIcon />Link</button>
            <button data-testid="new-figure" onClick={() => addCard('figure')}><PlusIcon />Figure</button>
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
        )}
        <ProjectSwitcher
          projects={projects}
          currentId={currentProjectId}
          onSwitch={switchProject}
          onCreate={createFlow}
          onRename={renameFlow}
        />
      </div>
      <div className="elves-stage" ref={stageRef} data-dragging={dragging} data-view={view}>
        <div className="elves-canvas-pane" style={{ width: canvasWidth }} data-collapsed={view === 'draft'}>
          <Tldraw
            key={currentProjectId ?? 'none'}
            shapeUtils={shapeUtils}
            getShapeVisibility={getShapeVisibility}
            onMount={handleMount}
          />
        </div>
        {view === 'split' && (
          <div
            className="elves-divider"
            style={{ left: `${split * 100}%` }}
            onPointerDown={onDividerDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize draft pane"
            data-testid="draft-divider"
          />
        )}
        <div
          className="elves-draft-pane"
          style={{ width: draftWidth }}
          aria-hidden={view === 'canvas'}
        >
          <DraftPane editor={editor} onSelectCard={onSelectCard} />
        </div>
        <DraftDrawerControls
          view={view}
          split={split}
          onExpand={expandDraft}
          onCollapse={collapseDraft}
        />
      </div>
    </div>
  )
}
