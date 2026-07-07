import { useState } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { CardShape } from '../shapes/CardShapeUtil'
import type { SectionShape } from '../shapes/SectionShapeUtil'
import { visibleComments } from '../model/comments'
import {
  compileDraft, draftToMarkdown, type DraftBlock, type DraftCardInput, type DraftSectionInput,
} from '../model/draft'
import './draft.css'

/**
 * The linear draft: the canvas read as a piece. It subscribes to the tldraw
 * store through `useValue` (so it recompiles live as cards move and text
 * changes) and renders the same `compileDraft` output the server/MCP produce —
 * section headings + prose paragraphs, in true narrative order. Read-only in v1:
 * the canvas stays the one place prose is written; here you *read*.
 */
export function DraftPane({
  editor,
  onSelectCard,
}: {
  editor: Editor | null
  /** Click-a-paragraph → navigate to its card on the canvas (draft → canvas sync). */
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
            continuous draft, in the order they'll be read.
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
                {block.cards.map((card) => (
                  <p
                    key={card.id}
                    className={`elves-draft__para${card.text.trim() ? '' : ' elves-draft__para--empty'}`}
                    data-testid="draft-para"
                    role="button"
                    tabIndex={0}
                    title="Go to this card on the canvas"
                    onClick={() => onSelectCard(card.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onSelectCard(card.id)
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
                ))}
              </section>
            ))}
          </article>
        )}
      </div>
    </div>
  )
}
