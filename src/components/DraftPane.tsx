import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { SectionShape } from '../shapes/SectionShapeUtil'
import { visibleComments } from '../model/comments'
import { reattribute, USER_AUTHOR } from '../model/attribution'
import {
  compileDraft, draftToMarkdown, type DraftBlock, type DraftCardInput, type DraftSectionInput,
} from '../model/draft'
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
}: {
  editor: Editor | null
  readOnly?: boolean
  /** Entering edit on a paragraph → select/centre its card on the canvas. */
  onSelectCard: (cardId: string) => void
}) {
  const blocks = useValue<DraftBlock[]>(
    'draft-blocks',
    () => {
      if (!editor) return []
      const cards: DraftCardInput[] = []
      const sections: DraftSectionInput[] = []
      for (const shape of editor.getCurrentPageShapes()) {
        // Page bounds resolve grouping/rotation to the card's real footprint,
        // so band assignment matches what the user sees on the board.
        const bounds = editor.getShapePageBounds(shape.id)
        if (!bounds) continue
        if (shape.type === 'card') {
          const p = (shape as CardShape).props
          cards.push({
            id: shape.id,
            kind: p.kind,
            x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h,
            text: p.text,
            mergedInto: p.mergedInto,
            draftExcluded: p.draftExcluded,
            unresolvedComments: visibleComments(p.comments).length,
          })
        } else if (shape.type === 'section') {
          const p = (shape as SectionShape).props
          sections.push({ id: shape.id, x: bounds.x, text: p.text, authoredBy: p.authoredBy })
        }
      }
      return compileDraft(cards, sections)
    },
    [editor],
  )

  // The paragraph currently open as a textarea (one at a time). Cleared on blur.
  const [editingId, setEditingId] = useState<string | null>(null)

  useEffect(() => {
    if (readOnly) setEditingId(null)
  }, [readOnly])

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draftToMarkdown(blocks))
      setCopyStatus('copied')
      setTimeout(() => setCopyStatus('idle'), 1400)
    } catch (err) {
      console.error('Elves: copy draft failed', err)
      setCopyStatus('error')
      setTimeout(() => setCopyStatus('idle'), 1400)
    }
  }

  const startEditing = (cardId: string) => {
    if (readOnly) return
    onSelectCard(cardId)
    setEditingId(cardId)
  }

  const empty = blocks.length === 0

  return (
    <div className="elves-draft" data-testid="draft-pane">
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
      <div className="elves-draft__scroll">
        {empty ? (
          <p className="elves-draft__blank" data-testid="draft-empty">
            Nothing to read yet. Prose cards you write on the canvas appear here as a
            continuous draft, in the order they'll be read. Click any paragraph to edit it.
          </p>
        ) : (
          <article className="elves-draft__body">
            {blocks.map((block) => (
              <section key={block.sectionId ?? '__opening__'} className="elves-draft__section">
                {block.section !== null && (
                  <h2
                    className="elves-draft__heading"
                    data-authored-by={block.authoredBy ?? 'user'}
                    data-testid="draft-heading"
                  >
                    {block.section}
                  </h2>
                )}
                {block.cards.map((card) =>
                  !readOnly && editor && editingId === card.id ? (
                    <ProseEditor
                      key={card.id}
                      editor={editor}
                      cardId={card.id}
                      initialText={card.text}
                      onDone={() => setEditingId(null)}
                    />
                  ) : (
                    <p
                      key={card.id}
                      className={`elves-draft__para${card.text.trim() ? '' : ' elves-draft__para--empty'}`}
                      data-testid="draft-para"
                      role="button"
                      aria-disabled={readOnly}
                      tabIndex={readOnly ? -1 : 0}
                      title={readOnly ? 'Draft editing is temporarily unavailable' : 'Click to edit — updates the card on the canvas'}
                      onClick={() => startEditing(card.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          startEditing(card.id)
                        }
                      }}
                    >
                      {card.text.trim() ? card.text : 'Empty card'}
                      {card.unresolvedComments ? (
                        <span
                          className="elves-draft__comments"
                          data-testid="draft-comment-marker"
                          title={`${card.unresolvedComments} unresolved comment${card.unresolvedComments === 1 ? '' : 's'}`}
                          aria-label={`${card.unresolvedComments} unresolved comments`}
                        >
                          {card.unresolvedComments}
                        </span>
                      ) : null}
                    </p>
                  ),
                )}
              </section>
            ))}
          </article>
        )}
      </div>
    </div>
  )
}

/**
 * A paragraph opened for editing: a textarea over the card's source text. The
 * write path mirrors the on-canvas card editor exactly (see CardShapeUtil) —
 * `text` plus a `reattribute` pass so per-character authorship stays correct —
 * so editing here and editing on the board are the same operation on one shape.
 */
function ProseEditor({
  editor,
  cardId,
  initialText,
  onDone,
}: {
  editor: Editor
  cardId: string
  initialText: string
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow the field to its content so the reading column never sprouts an inner
  // scrollbar — it reads like the paragraph it replaces, just taller as you type.
  const fit = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    fit(el)
    // Drop the caret at the end so you land ready to keep writing.
    const end = el.value.length
    el.setSelectionRange(end, end)
  }, [])

  return (
    <textarea
      ref={ref}
      className="elves-draft__editor"
      data-testid="draft-editor"
      autoFocus
      defaultValue={initialText}
      placeholder="Write prose…"
      onChange={(e) => {
        const value = e.currentTarget.value
        fit(e.currentTarget)
        const id = cardId as CardShape['id']
        const prev = editor.getShape<CardShape>(id)
        if (!prev) return
        editor.updateShape<CardShape>({
          id,
          type: 'card',
          props: {
            text: value,
            authoredBy: null,
            attribution: reattribute(prev.props.text, value, prev.props.attribution, USER_AUTHOR),
          },
        })
      }}
      onBlur={onDone}
      onKeyDown={(e) => {
        // Escape leaves edit mode. Enter is left alone — prose has paragraphs,
        // so a newline is the expected keystroke, not a commit. stopPropagation
        // keeps typing out of any global/canvas hotkey handlers.
        if (e.key === 'Escape') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        e.stopPropagation()
      }}
    />
  )
}
