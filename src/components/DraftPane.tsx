import {
  Fragment, useEffect, useRef, useState,
} from 'react'
import { createShapeId, useValue, type Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { SectionShape } from '../shapes/SectionShapeUtil'
import { reattribute, USER_AUTHOR } from '../model/attribution'
import { makeProseCardProps } from '../model/cards'
import { CANVAS_GAP } from '../model/layout'
import { draftToMarkdown, type DraftBlock } from '../model/draft'
import { compileEditorDraft } from '../client/editorDraft'
import { useDraftImageInsertion, type DraftImageInserter } from './useDraftImageInsertion'
import { DraftItemView } from './DraftItemView'
import './draft.css'

/**
 * The linear draft: the canvas read as a piece — and now written in, too. It
 * subscribes to the tldraw store through `useValue` (so it recompiles live as
 * cards move and text changes) and renders the same `compileDraft` output the
 * server/MCP produce — section headings + prose paragraphs, in true narrative
 * order.
 *
 * Editing is symmetric with the canvas: click a paragraph and it becomes a
 * textarea over the *same* `CardShape.props.text` a prose card holds. The write
 * path is identical to the card's own editor (text + reattribution), so the two
 * views edit one source — type here and the canvas card updates, and vice versa.
 */
export function DraftPane({
  editor,
  readOnly = false,
  onSelectCard,
  onInsertImages,
}: {
  editor: Editor | null
  readOnly?: boolean
  /** Entering edit on a paragraph → select/centre its card on the canvas. */
  onSelectCard: (cardId: string) => void
  onInsertImages?: DraftImageInserter
}) {
  const blocks = useValue<DraftBlock[]>(
    'draft-blocks',
    () => editor ? compileEditorDraft(editor) : [],
    [editor],
  )

  // The paragraph currently open as a textarea (one at a time). Cleared on blur.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null)
  const [editingAtStartId, setEditingAtStartId] = useState<string | null>(null)
  const draftImages = useDraftImageInsertion({ blocks, editor, readOnly, onInsertImages })

  useEffect(() => {
    if (readOnly) {
      setEditingId(null)
      setEditingTitleId(null)
      setEditingAtStartId(null)
    }
  }, [readOnly])

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyAttemptRef = useRef(0)

  useEffect(() => () => {
    copyAttemptRef.current += 1
    if (copyResetTimerRef.current !== null) {
      clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = null
    }
  }, [])

  const copy = async () => {
    const attempt = ++copyAttemptRef.current
    if (copyResetTimerRef.current !== null) {
      clearTimeout(copyResetTimerRef.current)
      copyResetTimerRef.current = null
    }
    let nextStatus: 'copied' | 'error'
    try {
      await navigator.clipboard.writeText(draftToMarkdown(blocks))
      nextStatus = 'copied'
    } catch (err) {
      if (copyAttemptRef.current !== attempt) return
      console.error('Elves: copy draft failed', err)
      nextStatus = 'error'
    }
    if (copyAttemptRef.current !== attempt) return
    setCopyStatus(nextStatus)
    copyResetTimerRef.current = setTimeout(() => {
      if (copyAttemptRef.current !== attempt) return
      copyResetTimerRef.current = null
      setCopyStatus('idle')
    }, 1400)
  }

  const startEditing = (cardId: string) => {
    if (readOnly) return
    onSelectCard(cardId)
    setEditingAtStartId(null)
    setEditingId(cardId)
  }

  const splitProse = (cardId: string, text: string, cursor: number) => {
    if (!editor) return
    const source = editor.getShape<CardShape>(cardId as CardShape['id'])
    const sourceBounds = source && editor.getShapePageBounds(source.id)
    if (!source || !sourceBounds) return

    const block = blocks.find((candidate) => candidate.items.some((item) => item.id === cardId))
    const sourceIndex = block?.items.findIndex((item) => item.id === cardId) ?? -1
    if (!block || sourceIndex < 0) return

    const id = createShapeId()
    const before = text.slice(0, cursor)
    const after = text.slice(cursor)
    const props = { ...makeProseCardProps(after), w: source.props.w, h: source.props.h }
    const pagePosition = { x: sourceBounds.x, y: sourceBounds.y + sourceBounds.h + CANVAS_GAP }
    const localPosition = editor.getPointInParentSpace(source.id, pagePosition)
    const followingIds = block.items.slice(sourceIndex + 1).map((item) => item.id)

    editor.run(() => {
      editor.updateShape<CardShape>({
        id: source.id,
        type: 'card',
        props: {
          text: before,
          authoredBy: null,
          attribution: reattribute(source.props.text, before, source.props.attribution, USER_AUTHOR),
        },
      })
      editor.createShape<CardShape>({
        id,
        type: 'card',
        parentId: source.parentId,
        x: localPosition.x,
        y: localPosition.y,
        props,
      })

      let nextY = pagePosition.y + props.h + CANVAS_GAP
      for (const followingId of followingIds) {
        const following = editor.getShape<CardShape>(followingId as CardShape['id'])
        const bounds = following && editor.getShapePageBounds(following.id)
        if (!following || !bounds) continue
        const local = editor.getPointInParentSpace(following.id, { x: bounds.x, y: nextY })
        editor.updateShape<CardShape>({ id: following.id, type: 'card', x: local.x, y: local.y })
        nextY += bounds.h + CANVAS_GAP
      }
    })
    setEditingAtStartId(id)
    setEditingId(id)
  }

  const empty = blocks.length === 0

  return (
    <div
      className="elves-draft"
      data-testid="draft-pane"
      onPasteCapture={draftImages.onPasteCapture}
      onFocusCapture={draftImages.onFocusCapture}
      onBlurCapture={draftImages.onBlurCapture}
    >
      <header className="elves-draft__bar">
        <span className="elves-draft__label">Draft</span>
        <button
          className={`elves-draft__copy${copyStatus === 'error' ? ' elves-draft__copy--error' : ''}`}
          data-testid="draft-copy"
          onClick={copy}
          disabled={empty}
          title="Copy the draft as Markdown"
        >
          {copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? 'Copy failed' : 'Copy as Markdown'}
        </button>
      </header>
      {draftImages.imageError && (
        <div className="elves-draft__image-error" role="alert" data-testid="draft-image-error">
          {draftImages.imageError}
        </div>
      )}
      <div
        className="elves-draft__scroll"
        onDragOver={draftImages.onDragOver}
        onDrop={draftImages.onDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            draftImages.clearDropTarget()
          }
        }}
      >
        {empty ? (
          <>
            <DraftDropGap blockIndex={0} index={0} active={draftImages.dropTarget?.index === 0} />
            <p className="elves-draft__blank" data-testid="draft-empty">
              Nothing to read yet. Prose cards you write on the canvas appear here as a
              continuous draft, in the order they'll be read. Click any paragraph to edit it.
            </p>
          </>
        ) : (
          <article className="elves-draft__body">
            {blocks.map((block, blockIndex) => (
              <section key={block.sectionId ?? '__opening__'} className="elves-draft__section">
                {block.section !== null && (
                  <div className="elves-draft__heading-row">
                    <h2
                      className="elves-draft__heading"
                      data-authored-by={block.authoredBy ?? 'user'}
                      data-testid="draft-heading"
                    >
                      {!readOnly && editor && editingTitleId === block.sectionId ? (
                        <SectionTitleEditor
                          editor={editor}
                          sectionId={block.sectionId!}
                          initialText={block.section}
                          onDone={() => setEditingTitleId(null)}
                        />
                      ) : !readOnly ? (
                        <button
                          type="button"
                          className="elves-draft__title-edit-target"
                          aria-label="Edit section heading"
                          onClick={() => setEditingTitleId(block.sectionId!)}
                        >
                          {block.section}
                        </button>
                      ) : block.section}
                    </h2>
                  </div>
                )}
                {block.items.map((item, itemIndex) => (
                  <Fragment key={item.id}>
                    <DraftDropGap
                      blockIndex={blockIndex}
                      index={itemIndex}
                      active={draftImages.dropTarget?.blockIndex === blockIndex && draftImages.dropTarget.index === itemIndex}
                    />
                    <DraftItemView
                      item={item}
                      editor={editor}
                      readOnly={readOnly}
                      editingId={editingId}
                      editingTitleId={editingTitleId}
                      focusAtStartId={editingAtStartId}
                      onEdit={startEditing}
                      onEditTitle={setEditingTitleId}
                      onSplit={splitProse}
                      onFinishEditing={() => {
                        setEditingAtStartId(null)
                        setEditingId(null)
                      }}
                      onFinishTitle={() => setEditingTitleId(null)}
                    />
                  </Fragment>
                ))}
                <DraftDropGap
                  blockIndex={blockIndex}
                  index={block.items.length}
                  active={draftImages.dropTarget?.blockIndex === blockIndex && draftImages.dropTarget.index === block.items.length}
                />
              </section>
            ))}
          </article>
        )}
      </div>
    </div>
  )
}

function DraftDropGap({
  blockIndex,
  index,
  active,
}: {
  blockIndex: number
  index: number
  active: boolean
}) {
  return (
    <div
      className="elves-draft__drop-gap"
      data-draft-gap=""
      data-block-index={blockIndex}
      data-index={index}
      data-active={active}
      aria-hidden="true"
    />
  )
}

function SectionTitleEditor({
  editor, sectionId, initialText, onDone,
}: {
  editor: Editor
  sectionId: string
  initialText: string
  onDone: () => void
}) {
  return (
    <textarea
      className="elves-draft__title-editor elves-draft__section-editor"
      data-testid="draft-section-editor"
      autoFocus
      defaultValue={initialText}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => editor.updateShape<SectionShape>({
        id: sectionId as SectionShape['id'],
        type: 'section',
        props: { text: event.currentTarget.value, authoredBy: 'user' },
      })}
      onBlur={(event) => {
        if (event.currentTarget.value.trim() === '') editor.deleteShape(sectionId as SectionShape['id'])
        onDone()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.blur()
        event.stopPropagation()
      }}
    />
  )
}
