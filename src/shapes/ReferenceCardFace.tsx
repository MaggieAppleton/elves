import type { Reference } from '../model/types'
import { assetUrl } from '../client/assets'
import {
  refEyebrow, refMeta, refDescription, refTitle, hasLeftMedia, refHost,
} from '../model/references'

/** Opens the reference url in a new tab; stops the pointer event reaching tldraw. */
function openRef(url: string) {
  if (url) window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * The type-adaptive face of a reference note card. Presentational only — it
 * reads the structured `reference` and renders a paper / article / social /
 * book / software / … layout, with an explicit ↗ open control (so a single
 * click still selects the shape for tldraw) and a hover panel exposing the full
 * metadata. All display rules live in model/references.ts so they stay testable.
 */
export function ReferenceCardFace({ reference }: { reference: Reference }) {
  const ref = reference
  const eyebrow = refEyebrow(ref)
  const title = refTitle(ref)
  const meta = refMeta(ref)
  const desc = refDescription(ref)
  const leftMedia = hasLeftMedia(ref)
  const favicon = ref.faviconAssetId ? assetUrl(ref.faviconAssetId) : ''
  const media = ref.thumbnailAssetId ? assetUrl(ref.thumbnailAssetId) : ''

  const body = (
    <div className="elves-ref__body">
      <div className="elves-ref__eyebrow">
        {favicon
          ? <img className="elves-ref__favicon" src={favicon} alt="" draggable={false} />
          : <span className="elves-ref__glyph" data-reftype={ref.refType} aria-hidden="true" />}
        <span className="elves-ref__kind">{eyebrow}</span>
      </div>
      <div className="elves-ref__title" data-testid="ref-title">{title}</div>
      {meta && <div className="elves-ref__meta">{meta}</div>}
      {desc && <div className="elves-ref__desc">{desc}</div>}
    </div>
  )

  return (
    <div className="elves-ref" data-reftype={ref.refType} data-testid="ref-card">
      <button
        className="elves-ref__open"
        data-testid="ref-open"
        title={`Open ${ref.url}`}
        aria-label="Open link"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); openRef(ref.url) }}
      >
        {/* Phosphor "ArrowUpRight" */}
        <svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
          <path d="M200,64V168a8,8,0,0,1-16,0V83.31L69.66,197.66a8,8,0,0,1-11.32-11.32L172.69,72H88a8,8,0,0,1,0-16H192A8,8,0,0,1,200,64Z" />
        </svg>
      </button>

      {leftMedia
        ? (
          <div className="elves-ref__row">
            <img
              className={`elves-ref__media elves-ref__media--${ref.refType}`}
              src={media}
              alt=""
              draggable={false}
              data-testid="ref-media"
            />
            {body}
          </div>
        )
        : body}

      <div className="elves-ref__hover" data-testid="ref-hover">
        <div className="elves-ref__hover-title">{title}</div>
        {ref.authors.length > 0 && (
          <div className="elves-ref__hover-line">{ref.authors.join(', ')}</div>
        )}
        {(ref.venue || ref.year) && (
          <div className="elves-ref__hover-line">{[ref.venue, ref.year].filter(Boolean).join(' · ')}</div>
        )}
        {ref.description && <div className="elves-ref__hover-desc">{ref.description}</div>}
        <div className="elves-ref__hover-url">{ref.doi ? `doi:${ref.doi}` : (refHost(ref.url) || ref.url)}</div>
      </div>
    </div>
  )
}
