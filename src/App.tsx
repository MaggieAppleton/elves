import { useEffect, useRef, useState } from 'react'
import { Tldraw, Editor, createShapeId, type TLShapeId } from 'tldraw'
import { TextAUnderline, Notepad, ImagesSquare, Link, Slideshow, SelectionPlus } from '@phosphor-icons/react'
import 'tldraw/tldraw.css'
import './theme.css'
import { CardShapeUtil, CardShape } from './shapes/CardShapeUtil'
import { CardSelectionForeground } from './shapes/CardSelectionForeground'
import { measuredCardHeight, measuredFigureHeight, PROSE_TEXT_MIN } from './shapes/autosize'
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
  loadCanvasVersioned,
  saveCanvasVersioned,
  listProjects,
  createProject,
  renameProject,
  type Project,
} from './client/persistence'
import { uploadAsset, useAssetProject } from './client/assets'
import { isSummaryOp } from './model/changeset'
import { connectRealtime, RealtimeStatus } from './client/realtime'
import { trackSelection } from './client/selection'
import { markDoing, markLooking, clearPresence } from './client/presence'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { ReviewPanel } from './components/ReviewPanel'
import { fetchReviews, summonReview, dismissReview, retryReview } from './client/reviews'
import type { Review, PersonalityId } from './model/reviews'
import { LinkPrompt } from './components/LinkPrompt'
import { AgentBox } from './components/AgentBox'
import { DraftPane } from './components/DraftPane'
import { DraftDrawerControls } from './components/DraftDrawerControls'
import { type ViewState, moreDraft, lessDraft } from './client/viewMachine'
import { prefersReducedMotion } from './client/motion'
import {
  createCanvasWriteCoordinator,
  type CanvasWriteStatus,
} from './client/canvasWriteCoordinator'
import { createTldrawCanvasWriteCoordinatorEditor } from './client/tldrawCanvasWriteCoordinatorEditor'
import {
  canvasWriteStatusLabel,
  committedRenameProject,
  createAppCanvasMount,
  flushCanvasMountForSwitch,
  requestOwnedRemoteSync,
  type AppCanvasMount,
} from './client/appCanvasMount'
import { createPointerDragManager, type PointerDragManager } from './client/dividerDrag'

const shapeUtils = [CardShapeUtil, SectionShapeUtil, QuestionShapeUtil]
const components = { SelectionForeground: CardSelectionForeground }
const canvasTransport = {
  load: loadCanvasVersioned,
  save: saveCanvasVersioned,
  renameProject,
  listProjects,
}

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

function realtimeStatusLabel(status: RealtimeStatus): string {
  if (status === 'connected') return 'Connected — live agent updates are active'
  if (status === 'connecting') return 'Connecting live agent updates…'
  if (status === 'reconnecting') return 'Reconnecting — some agent changes may be delayed'
  return 'Disconnected — live agent updates may be delayed; canvas saves use HTTP'
}

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
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus>('connecting')
  const [canvasWriteStatus, setCanvasWriteStatus] = useState<CanvasWriteStatus>('loading')
  const [canvasMountKey, setCanvasMountKey] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [pendingRenameName, setPendingRenameName] = useState<string | null>(null)
  // The open project's review passes (see src/model/reviews.ts) — fetched on
  // project switch, kept live by the realtime `reviews` message.
  const [reviews, setReviews] = useState<Review[]>([])
  const [showTools, setShowTools] = useState(false)
  const [linkPromptOpen, setLinkPromptOpen] = useState(false)
  const [agentBoxOpen, setAgentBoxOpen] = useState(false)
  const [agentRunning, setAgentRunning] = useState(false)
  const [reviewRequestCount, setReviewRequestCount] = useState(0)
  // How many shapes are selected right now, kept live so the agent box can show
  // its scope ("N selected" vs "Whole canvas") and tell the agent whether to
  // read_selection or read_map.
  const [selectedCount, setSelectedCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const canvasMountRef = useRef<AppCanvasMount | null>(null)
  const transitionRef = useRef<Promise<void> | null>(null)
  const reviewMutationControllersRef = useRef(new Set<AbortController>())
  const canvasMutationsLocked = !editor || transitioning ||
    canvasWriteStatus === 'renaming' || canvasWriteStatus === 'rename-ambiguous'
  // Server-side agent/review runs cannot join the local canvas drain. Keep the
  // project identity fixed until they settle or the user cancels them.
  const activeServerMutation = agentRunning || reviewRequestCount > 0 || reviews.some(
    (review) => review.status === 'pending' || review.status === 'in-progress',
  )
  // Project ids can repeat across an A → B → A switch, so id equality alone
  // cannot identify the review lifecycle that launched an async fetch. Bump a
  // visit token on every switch and require completions to match it.
  const reviewVisitRef = useRef(0)
  // Orders review snapshots within one visit. Every HTTP read claims a revision
  // when it starts; a later read or realtime snapshot advances the revision so
  // an older completion cannot replace newer review state.
  const reviewRevisionRef = useRef(0)
  // Counts spawns via addCard/addSection so each new card/section cascades
  // away from the last instead of stacking invisibly at the viewport center.
  const spawnCountRef = useRef(0)

  // Three view states — canvas only, split, draft only — plus the split ratio
  // (canvas fraction). tldraw stays MOUNTED in all three; draft-only just
  // collapses its pane width to 0, so the store, persistence, and realtime never
  // tear down. Both persist per project (loaded on switch, below).
  const [view, setView] = useState<ViewState>('canvas')
  const [split, setSplit] = useState(DEFAULT_SPLIT)
  const [dragging, setDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasPaneRef = useRef<HTMLDivElement>(null)
  const dividerDragRef = useRef<PointerDragManager | null>(null)

  // Bind asset routing after commit so aborted renders cannot
  // retarget mounted images; its tldraw atom invalidates tracked card renderers.
  useAssetProject(currentProjectId)

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

  const resyncOnReconnect = () => {
    const mount = canvasMountRef.current
    if (!mount) return
    void requestOwnedRemoteSync(mount, mount.project.id, false).catch((err) =>
      console.error('Elves: resync after reconnect failed', err),
    )
  }

  // One external subscription for the app lifetime. Every callback re-checks
  // mount ownership so stale socket events cannot reach a replaced editor.
  useEffect(
    () =>
      connectRealtime(
        (projectId, cs) => {
          const glow = cs.ops.some((op) => !isSummaryOp(op))
          void requestOwnedRemoteSync(canvasMountRef.current, projectId, glow).catch((err) =>
            console.error('Elves: realtime canvas sync failed', err),
          )
        },
        (projectId, presence) => {
          // The agent is "looking" at these cards (read_cards). Ephemeral: no
          // document change, no save — just a glow on cards that actually exist
          // in the open project.
          const mount = canvasMountRef.current
          if (!mount?.writeCoordinator.ownsProject(projectId) || !mount.initialized) return
          const ed = mount.editor
          const present = presence.cardIds.filter((id) => ed.getShape(id as CardShape['id']))
          markLooking(present as CardShape['id'][])
        },
        {
          onStatus: setRealtimeStatus,
          onReconnect: resyncOnReconnect,
          onReviews: (projectId, next) => {
            if (canvasMountRef.current?.writeCoordinator.ownsProject(projectId)) {
              reviewRevisionRef.current++
              setReviews(next)
            }
          },
        },
      ),
    [],
  )

  // Load the open project's review passes; a summon/claim/completion from any
  // surface (panel, MCP, another tab) arrives through onReviews above.
  useEffect(() => {
    const visit = ++reviewVisitRef.current
    const revision = ++reviewRevisionRef.current
    setReviews([])
    if (!currentProjectId) return
    fetchReviews(currentProjectId)
      .then((list) => {
        if (
          reviewVisitRef.current === visit &&
          reviewRevisionRef.current === revision &&
          canvasMountRef.current?.writeCoordinator.ownsProject(currentProjectId)
        ) {
          setReviews(list)
        }
      })
      .catch((err) => console.error('Elves: failed to load reviews', err))
    return () => {
      if (reviewVisitRef.current === visit) reviewVisitRef.current++
    }
  }, [currentProjectId])

  const refreshReviewsForVisit = async (pid: string, visit: number) => {
    if (reviewVisitRef.current !== visit ||
      !canvasMountRef.current?.writeCoordinator.ownsProject(pid)) return
    const revision = ++reviewRevisionRef.current
    const list = await fetchReviews(pid)
    if (
      reviewVisitRef.current === visit &&
      reviewRevisionRef.current === revision &&
      canvasMountRef.current?.writeCoordinator.ownsProject(pid)
    ) {
      setReviews(list)
    }
  }

  const mergeReviewForVisit = (pid: string, visit: number, review: Review) => {
    if (reviewVisitRef.current !== visit ||
      !canvasMountRef.current?.writeCoordinator.ownsProject(pid)) return
    reviewRevisionRef.current++
    setReviews((current) => {
      if (reviewVisitRef.current !== visit ||
        !canvasMountRef.current?.writeCoordinator.ownsProject(pid)) return current
      const index = current.findIndex((candidate) => candidate.id === review.id)
      if (index < 0) return [...current, review]
      const next = [...current]
      next[index] = review
      return next
    })
  }

  const refreshReviewsAfterMutation = (pid: string, visit: number) =>
    refreshReviewsForVisit(pid, visit).catch((err) =>
      console.error('Elves: failed to refresh reviews', err),
    )

  const handleSummonReview = (personality: PersonalityId, focus: string | null) => {
    if (canvasMutationsLocked) return
    const pid = currentProjectId
    if (!pid) return
    const visit = reviewVisitRef.current
    const controller = new AbortController()
    reviewMutationControllersRef.current.add(controller)
    setReviewRequestCount((count) => count + 1)
    // The websocket echo will also land; setting from the fetch keeps the panel
    // truthful even if the socket is down.
    summonReview(pid, personality, focus, controller.signal)
      .then((review) => {
        mergeReviewForVisit(pid, visit, review)
        return refreshReviewsAfterMutation(pid, visit)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.error('Elves: failed to summon review', err)
      })
      .finally(() => {
        reviewMutationControllersRef.current.delete(controller)
        setReviewRequestCount((count) => Math.max(0, count - 1))
      })
  }

  const handleDismissReview = (reviewId: string) => {
    if (canvasMutationsLocked) return
    const pid = currentProjectId
    if (!pid) return
    const visit = reviewVisitRef.current
    const controller = new AbortController()
    reviewMutationControllersRef.current.add(controller)
    setReviewRequestCount((count) => count + 1)
    dismissReview(pid, reviewId, controller.signal)
      .then((review) => {
        mergeReviewForVisit(pid, visit, review)
        return refreshReviewsAfterMutation(pid, visit)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.error('Elves: failed to dismiss review', err)
      })
      .finally(() => {
        reviewMutationControllersRef.current.delete(controller)
        setReviewRequestCount((count) => Math.max(0, count - 1))
      })
  }

  const handleRetryReview = (reviewId: string) => {
    if (canvasMutationsLocked) return
    const pid = currentProjectId
    if (!pid) return
    // The launch itself is fire-and-forget on the server; the WS broadcast
    // carries the resulting pending → in-progress transition to the panel.
    const visit = reviewVisitRef.current
    const controller = new AbortController()
    reviewMutationControllersRef.current.add(controller)
    setReviewRequestCount((count) => count + 1)
    retryReview(pid, reviewId, controller.signal)
      .then((review) => {
        mergeReviewForVisit(pid, visit, review)
        return refreshReviewsAfterMutation(pid, visit)
      })
      .catch((err) => {
        if (!controller.signal.aborted) console.error('Elves: failed to retry review', err)
      })
      .finally(() => {
        reviewMutationControllersRef.current.delete(controller)
        setReviewRequestCount((count) => Math.max(0, count - 1))
      })
  }

  // Presence is keyed by shape id; dropping it on project switch is cheap
  // insurance against a stale glow lingering as a new project's cards mount.
  useEffect(() => {
    clearPresence()
  }, [currentProjectId])

  useEffect(() => () => {
    for (const controller of reviewMutationControllersRef.current) controller.abort()
    reviewMutationControllersRef.current.clear()
    canvasMountRef.current?.dispose()
    canvasMountRef.current = null
  }, [])

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
    if (currentProjectId) localStorage.setItem(viewKey(currentProjectId), next)
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

  // A drag belongs to the current view lifetime. Ending it on a view change or
  // final unmount removes every window listener and restores pane transitions.
  useEffect(() => () => dividerDragRef.current?.end(), [view])

  // Keyboard: ⌘/Ctrl + \ widens the drawer (more draft); add Shift to narrow it
  // (less draft). A modifier is required so it never fights typing in a card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (linkPromptOpen) return
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === '\\') {
        e.preventDefault()
        changeView(e.shiftKey ? lessDraft(view) : moreDraft(view))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, linkPromptOpen, currentProjectId])

  // `/` opens the agent box — but ONLY when you're not typing. A bare key (no
  // modifier) would otherwise steal every slash you write, so bail out whenever
  // focus is in a text field or a card is being edited, leaving `/` a literal
  // slash there. Capture phase so we decide before tldraw sees the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (linkPromptOpen || canvasMutationsLocked) return
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
  }, [linkPromptOpen, canvasMutationsLocked])

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
    const drag = dividerDragRef.current ??= createPointerDragManager(window, setDragging)
    drag.start(e.pointerId, (ev) => {
      const rect = stage.getBoundingClientRect()
      if (rect.width === 0) return
      const r = (ev.clientX - rect.left) / rect.width
      setSplit(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, r)))
    })
  }

  // Split view: pan (keeping zoom) to a clicked paragraph's card and select it.
  // The canvas is already visible here, so we can centre on the card directly.
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
    // In the isolated writing view (draft-only), editing a paragraph must stay
    // there — clicking in must not pull the canvas back into view. We still sync
    // the canvas selection silently (pure state, no viewport change) so it's
    // right if the user switches back, but we don't change the view or pan a
    // hidden, zero-width canvas.
    if (view === 'draft') {
      editorRef.current?.select(cardId as CardShape['id'])
      return
    }
    focusCard(cardId)
  }

  const addImageCard = (
    mount: AppCanvasMount,
    file: File,
    point?: { x: number; y: number },
  ) => mount.runCommand(async ({ projectId, assertCurrent }) => {
    let aspect = 0.7
    try {
      const bmp = await createImageBitmap(file)
      if (bmp.width > 0) aspect = bmp.height / bmp.width
      bmp.close?.()
    } catch {
      /* keep default aspect */
    }
    assertCurrent()
    const w = 280
    const h = Math.max(80, Math.round(w * aspect))
    const assetId = await uploadAsset(projectId, file)
    assertCurrent()
    const at = point ?? mount.editor.getViewportPageBounds().center
    const id = createShapeId()
    mount.editor.createShape<CardShape>({
      id,
      type: 'card',
      x: at.x - w / 2,
      y: at.y - h / 2,
      props: { ...makeImageNoteCardProps(assetId), w, h },
    })
    mount.editor.select(id)
  })

  // Turn a url into a reference card: unfurl it (title/site/favicon/hero, cached
  // as local assets) and drop the type-adaptive card at the given point.
  const addReferenceFromUrl = (
    mount: AppCanvasMount,
    url: string,
    point?: { x: number; y: number },
  ) => mount.runCommand(async ({ projectId, assertCurrent }) => {
    const reference = await requestUnfurl(projectId, url)
    assertCurrent()
    const props = makeReferenceCardProps(reference)
    const at = point ?? mount.editor.getViewportPageBounds().center
    const id = createShapeId()
    mount.editor.createShape<CardShape>({
      id,
      type: 'card',
      x: at.x - props.w / 2,
      y: at.y - props.h / 2,
      props,
    })
    mount.editor.select(id)
  })

  const activateCanvasMount = (mount: AppCanvasMount) => {
    setCanvasWriteStatus('loading')
    void mount.initialize()
      .then((ready) => {
        const ed = mount.editor
        if (!ready || canvasMountRef.current !== mount || ed.isDisposed) return
        if (editorRef.current === ed) return
        mount.restartSelection(() =>
          trackSelection(ed, { getProjectId: () => mount.project.id }),
        )
        ed.registerExternalContentHandler('files', async ({ files, point }) => {
          for (const file of files) {
            if (!file.type.startsWith('image/')) continue
            await addImageCard(mount, file, point).catch((err) =>
              console.error('Elves: dropped image command failed', err),
            )
          }
        })
        ed.registerExternalContentHandler('url', async ({ url, point }) => {
          await addReferenceFromUrl(mount, url, point).catch((err) =>
            console.error('Elves: dropped link command failed', err),
          )
        })
        editorRef.current = ed
        setEditor(ed)
      })
      .catch((err) => {
        if (canvasMountRef.current !== mount) return
        setCanvasWriteStatus('error')
        console.error('Elves: canvas coordinator initialization failed', err)
      })
  }

  const handleMount = (ed: Editor) => {
    const project = projects?.find((candidate) => candidate.id === currentProjectId)
    if (!project) return

    canvasMountRef.current?.dispose()
    editorRef.current = null
    setEditor(null)
    setCanvasWriteStatus('loading')

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

    let mount!: AppCanvasMount
    const writeCoordinator = createCanvasWriteCoordinator({
      project,
      editor: createTldrawCanvasWriteCoordinatorEditor(ed),
      transport: canvasTransport,
      onStatus: (status) => {
        if (canvasMountRef.current === mount) setCanvasWriteStatus(status)
      },
      onRemoteChange: (changedIds, glow) => {
        if (canvasMountRef.current === mount && glow) markDoing(changedIds as TLShapeId[])
      },
    })
    mount = createAppCanvasMount({
      project,
      editor: ed,
      writeCoordinator,
      listen: (listener) => ed.store.listen(listener, { source: 'user', scope: 'document' }),
    })
    canvasMountRef.current = mount
    activateCanvasMount(mount)

    return () => {
      mount.dispose()
      if (canvasMountRef.current === mount) {
        canvasMountRef.current = null
        editorRef.current = null
        setEditor(null)
      }
    }
  }

  const addCard = (kind: 'prose' | 'note' | 'figure') => {
    if (!editor) return
    const center = editor.getViewportPageBounds().center
    const props =
      kind === 'prose' ? makeProseCardProps()
      : kind === 'figure' ? makeFigureCardProps()
      : makeNoteCardProps()
    props.h = kind === 'figure'
      ? measuredFigureHeight(editor, props.figureTitle, props.text, props.w)
      : measuredCardHeight(
          editor,
          props.text,
          props.w,
          true,
          kind === 'prose' ? PROSE_TEXT_MIN : 0,
        )
    const id = createShapeId()
    editor.createShape<CardShape>({
      id,
      type: 'card',
      x: center.x - props.w / 2,
      y: center.y - props.h / 2,
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
    const mount = canvasMountRef.current
    if (!mount || !trimmed) return
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    try {
      await addReferenceFromUrl(mount, url)
      if (canvasMountRef.current === mount) setLinkPromptOpen(false)
    } catch (err) {
      console.error('Elves: failed to add link', err)
    }
  }

  const runTransition = async (transition: () => Promise<void>) => {
    const active = transitionRef.current
    if (active) {
      await active
      return runTransition(transition)
    }
    setTransitioning(true)
    let running!: Promise<void>
    running = (async () => {
      try {
        await transition()
      } finally {
        if (transitionRef.current === running) transitionRef.current = null
        setTransitioning(false)
      }
    })()
    transitionRef.current = running
    await running
  }

  const switchProject = (id: string) => runTransition(async () => {
    if (id === currentProjectId || activeServerMutation) return
    const mount = canvasMountRef.current
    if (mount) {
      try {
        await flushCanvasMountForSwitch(mount)
      } catch (err) {
        mount.openCommands()
        console.error('Elves: project switch blocked by canvas save failure', err)
        return
      }
      mount.dispose()
      if (canvasMountRef.current === mount) canvasMountRef.current = null
      editorRef.current = null
      setEditor(null)
    }
    localStorage.setItem(LAST_PROJECT_KEY, id)
    setCurrentProjectId(id)
    setCanvasMountKey((key) => key + 1)
  })

  const adoptRenamedProject = (mount: AppCanvasMount, oldId: string, updated: Project) => {
    mount.adoptProject(updated)
    mount.restartSelection(() =>
      trackSelection(mount.editor, { getProjectId: () => mount.project.id }),
    )
    if (updated.id !== oldId) migrateProjectLocalStorage(oldId, updated.id)
    localStorage.setItem(LAST_PROJECT_KEY, updated.id)
    setCurrentProjectId(updated.id)
    setProjects((current) => current?.map((project) =>
      project.id === oldId ? updated : project,
    ) ?? [])
  }

  const createFlow = async () => {
    if (activeServerMutation) return
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

  const renameTo = (name: string) => runTransition(async () => {
    if (!currentProjectId || activeServerMutation) return
    const mount = canvasMountRef.current
    if (!mount) return
    const ambiguousRetry = canvasWriteStatus === 'rename-ambiguous' &&
      pendingRenameName === name
    if (!ambiguousRetry && !mount.writeCoordinator.ownsProject(currentProjectId)) return
    setPendingRenameName(name)
    try {
      await mount.closeCommands()
      mount.writeCoordinator.markDirty()
      const oldId = currentProjectId
      let updated: Project
      try {
        updated = await mount.writeCoordinator.renameProject(name)
      } catch (err) {
        const committed = committedRenameProject(err)
        if (!committed) throw err
        updated = committed
      }
      adoptRenamedProject(mount, oldId, updated)
      setPendingRenameName(null)
      void listProjects()
        .then((list) => {
          if (canvasMountRef.current === mount &&
            mount.writeCoordinator.ownsProject(updated.id)) setProjects(list)
        })
        .catch((err) => console.error('Elves: failed to refresh projects after rename', err))
      const reviewVisit = reviewVisitRef.current
      void fetchReviews(updated.id)
        .then((list) => {
          if (reviewVisitRef.current === reviewVisit && canvasMountRef.current === mount &&
            mount.writeCoordinator.ownsProject(updated.id)) setReviews(list)
        })
        .catch((err) => console.error('Elves: failed to refresh reviews after rename', err))
    } catch (err) {
      console.error('Elves: failed to rename project', err)
    } finally {
      if (mount.writeCoordinator.ownsProject(mount.project.id)) mount.openCommands()
    }
  })

  const renameFlow = () => {
    if (!currentProjectId) return
    const cur = projects?.find((p) => p.id === currentProjectId)
    const name = window.prompt('Rename project', cur?.name ?? '')?.trim()
    if (name) void renameTo(name)
  }

  const retryCanvasInitialization = () => {
    const mount = canvasMountRef.current
    if (mount) activateCanvasMount(mount)
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
  const writeStatusLabel = canvasWriteStatusLabel(canvasWriteStatus)
  const realtimeLabel = realtimeStatusLabel(realtimeStatus)

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
        disabled={canvasMutationsLocked}
        onRunningChange={setAgentRunning}
        onClose={() => setAgentBoxOpen(false)}
      />
      {/* Canvas-editing chrome is only meaningful when the canvas is visible. */}
      {view !== 'draft' && (
        <button
          className="elves-tools-toggle"
          data-active={showTools}
          title="Show/hide drawing tools"
          disabled={canvasMutationsLocked}
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
        {canvasWriteStatus !== 'idle' && (
          <div
            className="elves-canvas-write-status"
            role="status"
            aria-live="polite"
            aria-label={writeStatusLabel}
            data-write-status={canvasWriteStatus}
            title={writeStatusLabel}
          >
            <span className="elves-status-text">{writeStatusLabel}</span>
          </div>
        )}
        {canvasWriteStatus === 'error' && !editor && (
          <button className="elves-status-action" onClick={retryCanvasInitialization}>
            Retry canvas
          </button>
        )}
        {canvasWriteStatus === 'rename-ambiguous' && pendingRenameName && (
          <button
            className="elves-status-action"
            aria-label={`Retry rename to ${pendingRenameName}`}
            disabled={transitioning}
            onClick={() => void renameTo(pendingRenameName)}
          >
            Retry rename
          </button>
        )}
        <div
          className="elves-realtime-status"
          data-status={realtimeStatus}
          aria-label={realtimeLabel}
          title={realtimeLabel}
        />
        <ReviewPanel
          projectId={currentProjectId}
          editor={editor}
          reviews={reviews}
          disabled={canvasMutationsLocked || reviewRequestCount > 0}
          onSummon={handleSummonReview}
          onDismiss={handleDismissReview}
          onRetry={handleRetryReview}
        />
        <ProjectSwitcher
          projects={projects}
          currentId={currentProjectId}
          disabled={activeServerMutation || transitioning || canvasWriteStatus === 'renaming' ||
            canvasWriteStatus === 'rename-ambiguous'}
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
            key={canvasMountKey}
            shapeUtils={shapeUtils}
            components={components}
            getShapeVisibility={getShapeVisibility}
            onMount={handleMount}
          />
          {/* Creation toolbar lives inside the canvas pane and scrolls internally
              when that pane is narrow, so it never spills in front of the prose. */}
          {view !== 'draft' && (
            <div
              className="elves-toolbar"
              onFocus={(event) => {
                if (event.target instanceof HTMLButtonElement) {
                  event.target.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' })
                }
              }}
            >
              <button disabled={canvasMutationsLocked} aria-label="New prose card" data-testid="new-prose" onClick={() => addCard('prose')}>
                <TextAUnderline className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Prose</span>
              </button>
              <button disabled={canvasMutationsLocked} aria-label="New note card" data-testid="new-note" onClick={() => addCard('note')}>
                <Notepad className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Notes</span>
              </button>
              <button disabled={canvasMutationsLocked} aria-label="Add image" data-testid="new-image" onClick={() => fileInputRef.current?.click()}>
                <ImagesSquare className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Image</span>
              </button>
              <button disabled={canvasMutationsLocked} aria-label="Add link" data-testid="new-reference" onClick={addReferenceFlow}>
                <Link className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Link</span>
              </button>
              <button disabled={canvasMutationsLocked} aria-label="New figure card" data-testid="new-figure" onClick={() => addCard('figure')}>
                <Slideshow className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Figure</span>
              </button>
              <button disabled={canvasMutationsLocked} aria-label="New section" data-testid="new-section" onClick={addSection}>
                <SelectionPlus className="elves-btn-icon" aria-hidden="true" />
                <span className="elves-toolbar__label">Section</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                disabled={canvasMutationsLocked}
                accept="image/*"
                style={{ display: 'none' }}
                data-testid="image-input"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  const mount = canvasMountRef.current
                  if (file && mount) {
                    void addImageCard(mount, file).catch((err) =>
                      console.error('Elves: failed to add image', err),
                    )
                  }
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
          <DraftPane editor={editor} readOnly={canvasMutationsLocked} onSelectCard={onSelectCard} />
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
