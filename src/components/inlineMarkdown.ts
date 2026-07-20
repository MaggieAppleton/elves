export type InlineMarkdownToken =
  | { type: 'text'; value: string }
  | { type: 'link'; label: string; href: string }

const markdownLink = /\[([^\]\n]+)\]\(([^)\s]+)\)/g
const safeProtocols = new Set(['http:', 'https:', 'mailto:'])

function isSafeLink(href: string): boolean {
  try {
    return safeProtocols.has(new URL(href).protocol)
  } catch {
    return false
  }
}

/** Turn the small Markdown subset the draft presents into safe render tokens. */
export function tokenizeInlineMarkdown(source: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = []
  let cursor = 0

  for (const match of source.matchAll(markdownLink)) {
    const index = match.index ?? 0
    const [raw, label, href] = match
    if (!isSafeLink(href)) continue

    if (index > cursor) {
      tokens.push({ type: 'text', value: source.slice(cursor, index) })
    }
    tokens.push({ type: 'link', label, href })
    cursor = index + raw.length
  }

  if (cursor < source.length) {
    tokens.push({ type: 'text', value: source.slice(cursor) })
  }
  return tokens
}
