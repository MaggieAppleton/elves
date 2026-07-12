import { useEffect, useRef, useState } from 'react'
import { Tldraw, Editor, getSnapshot, loadSnapshot, createShapeId, type TLShapeId } from 'tldraw'
import { TextAUnderline, Notepad, ImagesSquare, Link, Slideshow, SelectionPlus } from '@phosphor-icons/react'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { CardSelectionForeground } from './shapes/CardSelectionForeground'
import { cardIsHidden, collapseAll } from './shapes/mergeView'
import { SectionShapeUtil, SectionShape } from './shapes/SectionShapeUtil'
import { QuestionShapeUtil } from './shapes/QuestionShapeUtil'
import {
  makeProseCardProps, makeNoteCardProps, makeImageNoteCardProps, makeReferenceCardProps,
  makeFigureCardProps,
} from './model/cards'
import { makeSectionProps } from './model/sections'
import { cascadeOffset } from './model/layout'
import { requestUnfurl } from './client/references'
import {
  loadCanvas,
  saveCanvas,
  debounce,
  createSaver,
  listProjects,
  createProject,
  renameProject,
  type Project,
} from './client/persistence'
import { uploadAsset, setAssetProject } from './client/assets'
import { applyChangeSet } from './apply/applyChangeSet'
import type { ChangeSet } from './model/changeset'
import { isSummaryOp } from './model/changeset'
import { connectRealtime, RealtimeStatus } from './client/realtime'
import { trackSelection } from './client/selection'
import { markDoing, markLooking, clearPresence } from './client/presence'
import { shapeRecordsById, diffChangedIds } from './client/resync'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { ReviewPanel } from './components/ReviewPanel'
import { fetchReviews, summonReview, dismissReview } from './client/reviews'
import type { Review, PersonalityId } from './model/reviews'
import { LinkPrompt } from './components/LinkPrompt'
import { AgentBox } from './components/AgentBox'
import { DraftPane } from './components/DraftPane'
import { DraftDrawerControls } from './components/DraftDrawerControls'
import { type ViewState, moreDraft, lessDraft } from './client/viewMachine'
import { prefersReducedMotion, isElementWidthTransitionEnd } from './client/motion'

const shapeUtils = [CardShapeUtil, SectionShapeUtil, QuestionShapeUtil]
const components = { SelectionForeground: CardSelectionForeground }

// A dismissed question is answered/waved off: hidden from render AND hit-testing
// (so it can't linger as an invisible-yet-selectable ghost), but kept in the
// file so it stays recoverable and the agent still sees it in read_map.
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
  // Glow the cards the agent just acted on ("doing"). Summary/gist reconciles
  // (cards, comments, and questions) are background machine work, not the
  // agent working — skip them so the board doesn't flicker orange every time
  // a gist settles.
  if (cs.ops.some((op) => !isSummaryOp(op))) markDoing(affected)
  saveCanvas(projectId, getSnapshot(ed.store)).catch((err) =>
    console.error('Elves: canvas save failed', err),
  )
}

export default function App() {
  const [projects, setProjects] = useState<Project[] | null>(null) // null = still loading
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting')
  // The open project's review passes (see src/model/reviews.ts) — fetched on
  // project switch, kept live by the realtime `reviews` message.
  const [reviews, setReviews] = useState<Review[]>([])
  const [showTools, setShowTools] = useState(false)
  const [linkPromptOpen, setLinkPromptOpen] = useState(false)
  const [agentBoxOpen, setAgentBoxOpen] = useState(false)
  // How many shapes are selected right now, kept live so the agent box can show
  // its scope ("N selected" vs "Whole canvas") and tell the agent whether to
  // read_selection or read_map.
  const [selectedCount, setSelectedCount] = useState(0)
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
  // Coalesces steady-state resyncs (see resyncCanvas / scheduleResync below): a
  // fetch already in flight absorbs any broadcasts that arrive while it's
  // pending, rather than racing a second overlapping loadCanvas.
  // `deferred` holds a resync that arrived while the user was editing text: a
  // full loadSnapshot mid-edit resets tldraw's editingShapeId (dropping them to
  // select mode) and reverts keystrokes newer than the last autosave. The
  // instance_page_state after-change handler (handleMount) flushes it the moment
  // editing ends.
  const resyncStateRef = useRef<{ inFlight: boolean; pendingGlow: boolean; deferred: boolean }>({
    inFlight: false,
    pendingGlow: false,
    deferred: false,
  })
  // The open canvas's autosave, exposed so the resync can force it to the server
  // before re-fetching. Without this, a resync that fires while keystrokes are
  // still held in the 500ms debounce reloads a stale snapshot over them — the
  // note-blur truncation bug. Rewired on every mount (createSaver below).
  const autosaveRef = useRef<{ flush: () => void; whenIdle: () => Promise<void> } | null>(null)
  // Counts spawns via addCard/addSection so each new card/section cascades
  // away from the last instead of stacking invisibly at the viewport center.
  const spawnCountRef = useRef(0)
  // Disposes the selection reporter (trackSelection). Held so a project switch
  // can stop the outgoing editor's reactor before the new one starts, and the
  // final unmount can too — a reactor left running against a torn-down store
  // would fire on a disposed editor.
  const selectionStopRef = useRef<(() => void) | null>(null)

  // Three view states — canvas only, split, draft only — plus the split ratio
  // (canvas fraction). tldraw stays MOUNTED in all three; draft-only just
  // collapses its pane width to 0, so the store, persistence, and realtime never
  // tear down. Both persist per project (loaded on switch, below).
  const [view, setView] = useState<ViewState>('canvas')
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasPaneRef = useRef<HTMLDivElement>(null)

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

  // A disconnected-but-open tab can't just resume where it left off: the
  // server persists change-sets to disk independently, so this tab's in-memory
  // store may be stale relative to disk by the time the socket reconnects.
  // Re-fetch and loadSnapshot the CURRENTLY open project's authoritative
  // canvas — mirroring reconcilePendingChangeSets — before any local autosave
  // gets a chance to write the stale in-memory document back over it.
  const resyncOnReconnect = () => {
    const ed = editorRef.current
    const pid = projectIdRef.current
    if (!ed || !pid || !canvasLoadedRef.current) return
    loadCanvas(pid)
      .then((fresh: any) => {
        // A project switch (or unmount) may have moved on while we were fetching.
        if (projectIdRef.current !== pid || editorRef.current !== ed) return
        // Wrap in mergeRemoteChanges so the load is tagged source:'remote', not
        // 'user' — otherwise it would trip the {source:'user'} autosave listener
        // and schedule an echo save that could clobber a change the agent
        // persisted in the ~500ms debounce window after this fetch.
        if (fresh?.document) ed.store.mergeRemoteChanges(() => loadSnapshot(ed.store, fresh))
      })
      .catch((err) => console.error('Elves: resync after reconnect failed', err))
  }

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
          // Steady state: the server already applied AND persisted this
          // change-set (server/app.ts) before broadcasting it verbatim. Replaying
          // the ops here would mint a second, independent set of shape ids and
          // then echo-save, overwriting the server's card with a diverging copy
          // (issue #28). Re-fetch the authoritative snapshot instead — same
          // pattern reconcilePendingChangeSets already uses for the load window.
          const glow = cs.ops.some((op) => !isSummaryOp(op))
          scheduleResync(projectId, glow)
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
        {
          onStatus: setRealtimeStatus,
          onReconnect: resyncOnReconnect,
          onReviews: (projectId, next) => {
            if (projectId === projectIdRef.current) setReviews(next)
          },
        },
      ),
    [],
  )

  // Load the open project's review passes; a summon/claim/completion from any
  // surface (panel, MCP, another tab) arrives through onReviews above.
  useEffect(() => {
    setReviews([])
    if (!currentProjectId) return
    fetchReviews(currentProjectId)
      .then((list) => {
        if (projectIdRef.current === currentProjectId) setReviews(list)
      })
      .catch((err) => console.error('Elves: failed to load reviews', err))
  }, [currentProjectId])

  const handleSummonReview = (personality: PersonalityId, focus: string | null) => {
    const pid = currentProjectId
    if (!pid) return
    // The websocket echo will also land; setting from the fetch keeps the panel
    // truthful even if the socket is down.
    summonReview(pid, personality, focus)
      .then(() => fetchReviews(pid))
      .then((list) => {
        if (projectIdRef.current === pid) setReviews(list)
      })
      .catch((err) => console.error('Elves: failed to summon review', err))
  }

  const handleDismissReview = (reviewId: string) => {
    const pid = currentProjectId
    if (!pid) return
    dismissReview(pid, reviewId)
      .then(() => fetchReviews(pid))
      .then((list) => {
        if (projectIdRef.current === pid) setReviews(list)
      })
      .catch((err) => console.error('Elves: failed to dismiss review', err))
  }

  // Presence is keyed by shape id; dropping it on project switch is cheap
  // insurance against a stale glow lingering as a new project's cards mount.
  useEffect(() => {
    clearPresence()
  }, [currentProjectId])

  // Stop the selection reporter when the app unmounts (handleMount handles the
  // switch-to-switch handoff; this covers the final teardown).
  useEffect(() => () => selectionStopRef.current?.(), [])

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

  // `/` opens the agent box — but ONLY when you're not typing. A bare key (no
  // modifier) would otherwise steal every slash you write, so bail out whenever
  // focus is in a text field or a card is being edited, leaving `/` a literal
  // slash there. Capture phase so we decide before tldraw sees the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return
      if (editorRef.current?.getEditingShapeId()) return
      e.preventDefault()
      setAgentBoxOpen(true)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Keep the agent box's scope in sync with the live canvas selection. Selection
  // lives on session-scoped records, so we listen there; React bails on an
  // unchanged count, so the frequent camera changes in that scope are harmless.
  useEffect(() => {
    if (!editor) return
    const update = () => setSelectedCount(editor.getSelectedShapeIds().length)
    update()
    return editor.store.listen(update, { scope: 'session' })
  }, [editor])

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
    const reduceMotion = prefersReducedMotion()
    ed.centerOnPoint(bounds.center, reduceMotion ? undefined : { animation: { duration: 300 } })
  }

  const onSelectCard = (cardId: string) => {
    if (view === 'draft') {
      changeView('split')
      const pane = canvasPaneRef.current
      // The canvas pane widens on a CSS transition (theme.css .elves-canvas-pane,
      // 320ms); centering before it finishes measures a stale viewport. Wait for
      // that exact transition to end rather than guessing its duration. Reduced
      // motion disables the transition entirely (no transitionend will fire), so
      // skip straight to focusing in that case. A fallback timeout covers any
      // other case where transitionend never arrives (unmounted pane, interrupted
      // transition, etc).
      if (prefersReducedMotion() || !pane) {
        focusCard(cardId)
        return
      }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        pane.removeEventListener('transitionend', onTransitionEnd)
        clearTimeout(fallback)
        focusCard(cardId)
      }
      const onTransitionEnd = (e: TransitionEvent) => {
        if (!isElementWidthTransitionEnd(e, pane)) return
        finish()
      }
      pane.addEventListener('transitionend', onTransitionEnd)
      const fallback = setTimeout(finish, 340)
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

  // Re-fetch the server's authoritative snapshot and load it in place of
  // locally replaying a change-set. Shared by the steady-state realtime handler
  // (below) and the mount-time catch-up (reconcilePendingChangeSets, below):
  // both need "the server already has this — go get it" rather than reapplying
  // ops, which would mint a second set of shape ids and echo-save a diverging
  // copy over the server's (issue #28).
  //
  // `loadSnapshot` replaces the store's contents wholesale, so there's nothing
  // in the result to diff op-by-op the way applyChangeSet's return value works.
  // Instead, snapshot the shape records just before the load and diff them
  // against what's there right after, so callers that want the "doing" glow
  // (steady state) can still drive it off real ids.
  type ResyncResult =
    | { status: 'loaded'; changedIds: TLShapeId[] }
    // The fetch failed, or the project has no persisted document yet (a
    // brand-new project — the server won't synthesise a tldraw schema for it).
    | { status: 'no-document' }
    // The project switched (or this editor unmounted) while the fetch was in
    // flight; the response no longer applies to anything currently open.
    | { status: 'stale' }
  const resyncCanvas = async (ed: Editor, pid: string): Promise<ResyncResult> => {
    // The user's latest keystrokes may still be sitting in the 500ms autosave
    // debounce. loadSnapshot below replaces the store wholesale from the server,
    // so fetching before that save lands would revert them — and the next
    // debounce fire would then persist the reverted text (the note-blur
    // truncation bug). Force the held save out and wait for it to reach the
    // server first, so the snapshot we fetch already includes those keystrokes.
    // POST /canvas overwrites canvas.json then re-reconciles summaries, so this
    // can't lose a pending summary — it just re-broadcasts once editing ends.
    autosaveRef.current?.flush()
    await autosaveRef.current?.whenIdle()
    if (projectIdRef.current !== pid || editorRef.current !== ed) return { status: 'stale' }
    const before = shapeRecordsById(ed.store.allRecords())
    let fresh: any = null
    try {
      fresh = await loadCanvas(pid)
    } catch (err) {
      console.error('Elves: resync fetch failed', err)
    }
    if (projectIdRef.current !== pid || editorRef.current !== ed) return { status: 'stale' }
    if (!fresh?.document) return { status: 'no-document' }
    // Load through the remote-changes escape hatch: loadSnapshot's store writes
    // are otherwise tagged source:'user', which trips the {source:'user'}
    // autosave listener and schedules an echo POST /canvas. The ids are already
    // authoritative so that save wouldn't churn them, but the ~500ms debounce
    // window could clobber a concurrently-persisted agent change (issue #32's
    // hazard class). Tagging the load 'remote' excludes it from the listener.
    // The presence-glow diff below is independent of the change source: `before`
    // was captured above, and we re-read the store after, so markDoing still fires.
    ed.store.mergeRemoteChanges(() => loadSnapshot(ed.store, fresh))
    const changedIds = diffChangedIds(before, shapeRecordsById(ed.store.allRecords())) as TLShapeId[]
    return { status: 'loaded', changedIds }
  }

  // Coalesce steady-state resyncs: a fetch already in flight absorbs any
  // broadcasts that arrive while it's pending (accumulating whether any of them
  // should glow) instead of racing a second overlapping loadCanvas. Once the
  // in-flight fetch resolves, if more broadcasts arrived meanwhile it loops once
  // more to pick up the latest state; otherwise it stops.
  const scheduleResync = (pid: string, glow: boolean) => {
    const state = resyncStateRef.current
    state.pendingGlow = state.pendingGlow || glow
    // Hold the resync while a text edit is in progress. loadSnapshot replaces the
    // whole document, which resets editingShapeId (kicking the user out of the
    // card they're typing in) and reverts any keystrokes newer than the last
    // 500ms autosave. The common trigger is the user's OWN typing: each save
    // schedules the server summariser, which ~1.5s later broadcasts a set_summary
    // change-set back to this very tab. Deferring — not dropping — means the
    // summary still lands once editing ends (see the flush in handleMount).
    if (editorRef.current?.getEditingShapeId()) {
      state.deferred = true
      return
    }
    if (state.inFlight) return
    state.inFlight = true
    void (async () => {
      for (;;) {
        // The user may have entered a card between iterations; hold as above and
        // let the editing-end flush restart us so we never load over a live edit.
        if (editorRef.current?.getEditingShapeId()) {
          state.deferred = true
          break
        }
        const glowNow = state.pendingGlow
        state.pendingGlow = false
        const ed = editorRef.current
        if (ed && projectIdRef.current === pid) {
          const result = await resyncCanvas(ed, pid)
          if (result.status === 'loaded' && glowNow && result.changedIds.length) {
            markDoing(result.changedIds)
          }
        }
        if (!state.pendingGlow || projectIdRef.current !== pid) break
      }
      state.inFlight = false
    })()
  }

  // Once the canvas has loaded, reconcile any change-sets that arrived — and were
  // buffered — while it was still loading. Re-fetch once to tell two cases apart:
  //  • The server persisted them (a project that already has a document): the
  //    re-fetched snapshot is authoritative and already includes them, so reload
  //    it rather than replay — replaying would mint duplicate cards, since create
  //    ops assign fresh shape ids with nothing to dedupe against.
  //  • The server only broadcast them (a brand-new project with no document yet):
  //    nothing was persisted, so replay the buffered ops to materialise them; the
  //    save then writes the now-real document to disk.
  const reconcilePendingChangeSets = async (ed: Editor, pid: string) => {
    const queued = pendingChangeSetsRef.current.filter((e) => e.projectId === pid)
    // Reset unconditionally: anything not for `pid` is a straggler from a project
    // whose load never finished, and can't belong to the canvas mounting now.
    pendingChangeSetsRef.current = []
    if (!queued.length) return
    const result = await resyncCanvas(ed, pid)
    if (result.status !== 'no-document') return // 'loaded' already includes them; 'stale' means nothing to do here
    for (const { cs } of queued) applyAndPersist(ed, pid, cs)
  }

  const handleMount = (ed: Editor) => {
    editorRef.current = ed
    setEditor(ed)
    // Stop the previous editor's selection reporter before this one starts, so a
    // project switch never leaves a reactor firing against the torn-down store.
    selectionStopRef.current?.()
    selectionStopRef.current = null
    // A fresh mount hasn't loaded its canvas yet — hold off every save path.
    canvasLoadedRef.current = false
    // Drop the previous canvas's autosave so a resync can't flush a torn-down
    // saver; handleMount rewires it once this canvas finishes loading.
    autosaveRef.current = null
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
    // Flush a resync that was held while the user was editing (scheduleResync).
    // The instant they leave edit mode it's safe to replace the document, so pull
    // the server's authoritative snapshot — including any summary broadcast that
    // arrived and was deferred mid-edit.
    ed.sideEffects.registerAfterChangeHandler('instance_page_state', (prev, next) => {
      if (prev.editingShapeId && !next.editingShapeId && resyncStateRef.current.deferred) {
        resyncStateRef.current.deferred = false
        const pid = projectIdRef.current
        if (pid) scheduleResync(pid, false)
      }
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
        const saver = createSaver(() => saveCanvas(pid, getSnapshot(ed.store)))
        const save = debounce(saver.request, 500)
        ed.store.listen(save, { source: 'user', scope: 'document' })
        // Expose this canvas's autosave to the resync path (resyncCanvas), so it
        // can flush a held save to the server before re-fetching over the store.
        autosaveRef.current = { flush: save.flush, whenIdle: saver.whenIdle }
        // Report this editor's selection to the server so the agent can resolve
        // "this"/"these" (MCP read_selection). Tagged with the live project id so
        // it's correct across switches; disposed on the next mount / unmount.
        selectionStopRef.current = trackSelection(ed, { getProjectId: () => projectIdRef.current })
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
    const { dx, dy } = cascadeOffset(spawnCountRef.current++)
    const id = createShapeId()
    editor.createShape<CardShape>({
      id,
      type: 'card',
      x: center.x - props.w / 2 + dx,
      y: center.y - props.h / 2 + dy,
      props,
    })
    editor.select(id)
    // A new card is born blank — drop straight into editing so the fields
    // are ready to type, the way a new section opens its editor.
    editor.setEditingShape(id)
  }

  const addSection = () => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props = makeSectionProps()
    const { dx, dy } = cascadeOffset(spawnCountRef.current++)
    const id = createShapeId()
    editor.createShape<SectionShape>({
      id,
      type: 'section',
      x: center.x - props.w / 2 + dx,
      y: center.y - props.h / 2 + dy,
      props,
    })
    editor.select(id)
    editor.setEditingShape(id)
  }

  const addReferenceFlow = () => {
    if (!editor) return
    setLinkPromptOpen(true)
  }

  // Resolve a pasted link into a reference card. Bare hostnames get an https://
  // prefix so "example.com" unfurls as expected. Runs while the modal shows its
  // "Adding…" state; closes it once the card lands.
  const submitLink = async (raw: string) => {
    const trimmed = raw.trim()
    if (!editor || !trimmed) return
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    await addReferenceFromUrl(editor, url)
    setLinkPromptOpen(false)
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
      <LinkPrompt
        open={linkPromptOpen}
        onCancel={() => setLinkPromptOpen(false)}
        onSubmit={submitLink}
      />
      <AgentBox
        open={agentBoxOpen}
        projectId={currentProjectId}
        selectedCount={selectedCount}
        onClose={() => setAgentBoxOpen(false)}
      />
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
        <div
          className="elves-realtime-status"
          data-status={realtimeStatus}
          title={
            realtimeStatus === 'connected'
              ? 'Connected — your changes are saving'
              : realtimeStatus === 'connecting'
                ? 'Connecting…'
                : realtimeStatus === 'reconnecting'
                  ? 'Reconnecting — some agent changes may be delayed'
                  : 'Disconnected — the server is not running, so your changes are NOT being saved'
          }
        />
        <ReviewPanel
          projectId={currentProjectId}
          editor={editor}
          reviews={reviews}
          onSummon={handleSummonReview}
          onDismiss={handleDismissReview}
        />
        <ProjectSwitcher
          projects={projects}
          currentId={currentProjectId}
          onSwitch={switchProject}
          onCreate={createFlow}
          onRename={renameFlow}
        />
      </div>
      <div className="elves-stage" ref={stageRef} data-dragging={dragging} data-view={view}>
        <div
          className="elves-canvas-pane"
          ref={canvasPaneRef}
          style={{ width: canvasWidth }}
          data-collapsed={view === 'draft'}
        >
          <Tldraw
            key={currentProjectId ?? 'none'}
            shapeUtils={shapeUtils}
            components={components}
            getShapeVisibility={getShapeVisibility}
            onMount={handleMount}
          />
          {/* Creation toolbar lives inside the canvas pane so the draft pane
              (a sibling) paints over it and the pane's overflow clips it — it
              can never spill in front of the prose. */}
          {view !== 'draft' && (
            <div className="elves-toolbar">
              <button data-testid="new-prose" onClick={() => addCard('prose')}><TextAUnderline className="elves-btn-icon" aria-hidden="true" />Prose</button>
              <button data-testid="new-note" onClick={() => addCard('note')}><Notepad className="elves-btn-icon" aria-hidden="true" />Notes</button>
              <button data-testid="new-image" onClick={() => fileInputRef.current?.click()}><ImagesSquare className="elves-btn-icon" aria-hidden="true" />Image</button>
              <button data-testid="new-reference" onClick={addReferenceFlow}><Link className="elves-btn-icon" aria-hidden="true" />Link</button>
              <button data-testid="new-figure" onClick={() => addCard('figure')}><Slideshow className="elves-btn-icon" aria-hidden="true" />Figure</button>
              <button data-testid="new-section" onClick={addSection}><SelectionPlus className="elves-btn-icon" aria-hidden="true" />Section</button>
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
