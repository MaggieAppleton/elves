import { useLayoutEffect, useRef } from 'react'
import type { Editor } from 'tldraw'
import { assetUrl } from '../client/assets'
import { reattribute, USER_AUTHOR } from '../model/attribution'
import type { DraftItem } from '../model/draft'
import type { CardShape } from '../shapes/CardShapeUtil'
import { tokenizeInlineMarkdown } from './inlineMarkdown'

export function DraftItemView({
  item,
  editor,
  readOnly,
  editingId,
  editingTitleId,
  focusAtStartId,
  onEdit,
  onEditTitle,
  onSplit,
  onFinishEditing,
  onFinishTitle,
}: {
  item: DraftItem
  editor: Editor | null
  readOnly: boolean
  editingId: string | null
  editingTitleId: string | null
  focusAtStartId: string | null
  onEdit: (cardId: string) => void
  onEditTitle: (cardId: string) => void
  onSplit: (cardId: string, text: string, cursor: number) => void
  onFinishEditing: () => void
  onFinishTitle: () => void
}) {
  if (item.type === 'figure') {
    return (
      <figure className="elves-draft__figure" data-testid="draft-figure">
        <figcaption className="elves-draft__figure-title" data-testid="draft-figure-title">
          {!readOnly && editor && editingTitleId === item.id ? (
            <FigureTitleEditor
              editor={editor}
              cardId={item.id}
              initialText={item.title}
              onDone={onFinishTitle}
            />
          ) : !readOnly ? (
            <button
              type="button"
              className="elves-draft__title-edit-target"
              aria-label="Edit figure title"
              onClick={() => onEditTitle(item.id)}
            >
              {item.title.trim() || 'Untitled figure'}
            </button>
          ) : item.title.trim() || 'Untitled figure'}
          {item.status ? <span className="elves-draft__figure-status">{item.status}</span> : null}
        </figcaption>
        {item.description.trim() ? <p className="elves-draft__figure-desc">{item.description}</p> : null}
      </figure>
    )
  }

  if (item.type === 'image') {
    return (
      <figure className="elves-draft__image-wrap" data-testid="draft-image-block">
        <img className="elves-draft__image" data-testid="draft-image" src={assetUrl(item.assetId)} alt="" />
      </figure>
    )
  }

  if (!readOnly && editor && editingId === item.id) {
    return (
      <div className="elves-draft__prose-row" data-testid="draft-para" data-draft-prose-id={item.id}>
        <ProseEditor
          editor={editor}
          cardId={item.id}
          initialText={item.text}
          focusAtStart={focusAtStartId === item.id}
          onSplit={onSplit}
          onDone={onFinishEditing}
        />
      </div>
    )
  }

  return (
    <DraftProse
      cardId={item.id}
      text={item.text}
      unresolvedComments={item.unresolvedComments}
      readOnly={readOnly}
      onEdit={onEdit}
    />
  )
}

function DraftProse({
  cardId,
  text,
  unresolvedComments,
  readOnly,
  onEdit,
}: {
  cardId: string
  text: string
  unresolvedComments?: number
  readOnly: boolean
  onEdit: (cardId: string) => void
}) {
  const empty = !text.trim()
  return (
    <div
      className={`elves-draft__prose-row${empty ? ' elves-draft__prose-row--empty' : ''}${readOnly ? ' elves-draft__prose-row--read-only' : ''}`}
      data-testid="draft-para"
      data-draft-prose-id={cardId}
    >
      <div className="elves-draft__prose-content">
        {!readOnly ? (
          <button
            type="button"
            className="elves-draft__edit-target"
            aria-label="Edit paragraph"
            title="Click to edit — updates the card on the canvas"
            onClick={() => onEdit(cardId)}
          />
        ) : null}
        <p className="elves-draft__para">
          {empty ? 'Empty card' : tokenizeInlineMarkdown(text).map((token, index) => (
            token.type === 'text' ? token.value : (
              <a
                key={`${token.href}-${index}`}
                className="elves-draft__link"
                href={token.href}
                target="_blank"
                rel="noreferrer"
              >
                {token.label}
              </a>
            )
          ))}
          {unresolvedComments ? (
            <span
              className="elves-draft__comments"
              data-testid="draft-comment-marker"
              title={`${unresolvedComments} unresolved comment${unresolvedComments === 1 ? '' : 's'}`}
              aria-label={`${unresolvedComments} unresolved comments`}
            >
              {unresolvedComments}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  )
}

function ProseEditor({
  editor,
  cardId,
  initialText,
  focusAtStart,
  onSplit,
  onDone,
}: {
  editor: Editor
  cardId: string
  initialText: string
  focusAtStart: boolean
  onSplit: (cardId: string, text: string, cursor: number) => void
  onDone: () => void
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const fit = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    fit(element)
    const caret = focusAtStart ? 0 : element.value.length
    element.setSelectionRange(caret, caret)
  }, [])

  return (
    <textarea
      ref={ref}
      className="elves-draft__editor"
      data-testid="draft-editor"
      autoFocus
      defaultValue={initialText}
      placeholder="Write prose…"
      onChange={(event) => {
        const value = event.currentTarget.value
        fit(event.currentTarget)
        const id = cardId as CardShape['id']
        const previous = editor.getShape<CardShape>(id)
        if (!previous) return
        editor.updateShape<CardShape>({
          id,
          type: 'card',
          props: {
            text: value,
            authoredBy: null,
            attribution: reattribute(
              previous.props.text,
              value,
              previous.props.attribution,
              USER_AUTHOR,
            ),
          },
        })
      }}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          onSplit(cardId, event.currentTarget.value, event.currentTarget.selectionStart)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.currentTarget.blur()
        }
        event.stopPropagation()
      }}
    />
  )
}

function FigureTitleEditor({
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
  return (
    <textarea
      className="elves-draft__title-editor elves-draft__figure-editor"
      data-testid="draft-figure-editor"
      autoFocus
      defaultValue={initialText}
      onClick={(event) => event.stopPropagation()}
      onChange={(event) => editor.updateShape<CardShape>({
        id: cardId as CardShape['id'],
        type: 'card',
        props: { figureTitle: event.currentTarget.value, authoredBy: null },
      })}
      onBlur={onDone}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.currentTarget.blur()
        event.stopPropagation()
      }}
    />
  )
}
