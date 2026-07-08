import type { CSSProperties, ReactNode } from 'react'
import type { Attribution } from '../model/types'
import { normalizeAttribution, USER_AUTHOR } from '../model/attribution'
import { authorInfo } from './agents'

/**
 * A card's body text rendered so each author's stretch can be revealed — the
 * "blame" view. The text is sliced by the attribution runs (see
 * src/model/attribution): each run written by an agent is wrapped in a
 * `.elves-blame-run` span tinted that agent's accent; the human's ('user') and
 * any unknown-agent runs render as plain text so they read normally.
 *
 * Crucially the spans are ALWAYS emitted, tint and all held behind a CSS var —
 * the accent only shows when an ancestor carries `.elves-blame-active` (toggled
 * by hovering the author marks). So this component is a pure function of
 * (text, attribution): hovering flips a class on the parent, never re-renders
 * here. Whitespace/newlines are preserved by the container's `white-space:
 * pre-wrap`; slicing the raw string keeps them intact.
 *
 * Robust to a null/short/corrupt attribution: normalizeAttribution repairs it to
 * a single 'user' run, so a broken attribution degrades to plain text rather
 * than dropping characters.
 */
export function BlameText({
  text,
  attribution,
}: {
  text: string
  attribution: Attribution | null
}) {
  const runs = normalizeAttribution(attribution, text.length)
  const nodes: ReactNode[] = []
  let pos = 0
  runs.forEach((run, i) => {
    const slice = text.slice(pos, pos + run.length)
    pos += run.length
    const info = run.author !== USER_AUTHOR ? authorInfo(run.author) : null
    if (info) {
      nodes.push(
        <span
          key={i}
          className="elves-blame-run"
          data-blame-author={info.id}
          style={{ '--blame-accent': info.accent } as CSSProperties}
        >
          {slice}
        </span>,
      )
    } else {
      // Human or unknown author: plain text, never tinted.
      nodes.push(slice)
    }
  })
  return <>{nodes}</>
}

/**
 * Whether an attribution has any run written by a *resolvable* agent — i.e.
 * something the blame view can actually tint. Gates the hover affordance so an
 * all-human card (or one whose only agent is unregistered) offers no reveal.
 */
export function hasAgentRun(attribution: Attribution | null): boolean {
  return (attribution ?? []).some(
    (run) => run.author !== USER_AUTHOR && !!authorInfo(run.author),
  )
}
