# Minimal Draft and Markdown Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the linear draft into a plain white writing surface and render safe Markdown links without changing stored or exported prose.

**Architecture:** Add one pure client-side tokenizer for `[label](url)` links, then render its tokens inside a prose row whose edit button and anchors are sibling interactive controls. Keep `CardShape.props.text` as raw Markdown and leave the shared compiler/server/MCP contracts unchanged. Simplify only the draft pane CSS, retaining faint dashed frames for figures and images.

**Tech Stack:** TypeScript, React 18, tldraw, CSS, Vitest/jsdom, Playwright.

---

### Task 1: Link-only Markdown tokenizer

**Files:**
- Create: `src/components/inlineMarkdown.ts`
- Create: `tests/components/inlineMarkdown.test.ts`

- [ ] **Step 1: Write the failing tokenizer tests**

Create tests for plain text, multiple safe links, punctuation, malformed syntax, and unsafe schemes:

```ts
import { describe, expect, test } from 'vitest'
import { tokenizeInlineMarkdown } from '../../src/components/inlineMarkdown'

describe('tokenizeInlineMarkdown', () => {
  test('keeps plain text as one token', () => {
    expect(tokenizeInlineMarkdown('Plain prose.')).toEqual([{ type: 'text', value: 'Plain prose.' }])
  })

  test('extracts multiple safe Markdown links without losing punctuation', () => {
    expect(tokenizeInlineMarkdown('Read [one](https://one.test), then [two](mailto:two@test.dev).')).toEqual([
      { type: 'text', value: 'Read ' },
      { type: 'link', label: 'one', href: 'https://one.test' },
      { type: 'text', value: ', then ' },
      { type: 'link', label: 'two', href: 'mailto:two@test.dev' },
      { type: 'text', value: '.' },
    ])
  })

  test.each([
    '[broken](not a url)',
    '[unsafe](javascript:alert(1))',
    '[unfinished](https://example.com',
  ])('leaves malformed or unsafe Markdown literal: %s', (source) => {
    expect(tokenizeInlineMarkdown(source)).toEqual([{ type: 'text', value: source }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/components/inlineMarkdown.test.ts`

Expected: FAIL because `src/components/inlineMarkdown.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure tokenizer**

Create a discriminated token type and scan only complete single-line Markdown links. Accept `http:`, `https:`, and `mailto:` URLs. When a match is unsafe, leave it inside the next text token rather than creating an anchor.

```ts
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

export function tokenizeInlineMarkdown(source: string): InlineMarkdownToken[] {
  const tokens: InlineMarkdownToken[] = []
  let cursor = 0
  for (const match of source.matchAll(markdownLink)) {
    const index = match.index ?? 0
    const [raw, label, href] = match
    if (!isSafeLink(href)) continue
    if (index > cursor) tokens.push({ type: 'text', value: source.slice(cursor, index) })
    tokens.push({ type: 'link', label, href })
    cursor = index + raw.length
  }
  if (cursor < source.length) tokens.push({ type: 'text', value: source.slice(cursor) })
  return tokens
}
```

- [ ] **Step 4: Run tokenizer tests**

Run: `npm test -- tests/components/inlineMarkdown.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the tokenizer slice**

```bash
git add src/components/inlineMarkdown.ts tests/components/inlineMarkdown.test.ts
git commit -m "feat: parse safe links in draft prose"
```

### Task 2: Render links without nesting interactive controls

**Files:**
- Modify: `src/components/DraftPane.tsx`
- Modify: `tests/components/DraftPane.test.ts`
- Modify: `tests/model/draft.test.ts`

- [ ] **Step 1: Write failing component and export tests**

Add a linked-prose editor fixture and assertions that:

```ts
const markdownEditor = {
  getCurrentPageShapes: () => [{
    id: 'shape:linked-prose',
    type: 'card',
    props: {
      kind: 'prose',
      text: 'Read [Maggie](https://maggieappleton.com) and [unsafe](javascript:alert(1)).',
      mergedInto: null,
      draftExcluded: false,
      comments: [],
      attribution: [],
    },
  }],
  getShapePageBounds: () => ({ x: 0, y: 0, w: 240, h: 120 }),
  getShape: vi.fn(() => ({ props: { text: '', attribution: [] } })),
  updateShape: vi.fn(),
} as unknown as Editor
```

The rendered anchor must have label `Maggie`, the exact HTTPS destination, `target="_blank"`, and `rel="noreferrer"`. The unsafe Markdown must remain literal. The prose row must contain a sibling `button[aria-label="Edit paragraph"]`, not a button or `role="button"` ancestor around the anchor. Clicking the anchor must not call `onSelectCard`; clicking the edit button must open a textarea whose value is the exact raw Markdown.

Extend `draftToMarkdown` coverage with:

```ts
test('preserves inline Markdown links in prose verbatim', () => {
  const source = 'Read [Maggie](https://maggieappleton.com).'
  expect(draftToMarkdown(compileDraft([card({ id: 'linked', text: source })], []))).toBe(source)
})
```

- [ ] **Step 2: Run focused tests to verify failure**

Run: `npm test -- tests/components/DraftPane.test.ts tests/model/draft.test.ts`

Expected: FAIL because the draft currently renders raw Markdown and exposes the whole paragraph as `role="button"`.

- [ ] **Step 3: Add the accessible prose-row renderer**

Import `tokenizeInlineMarkdown`. Extract a small `DraftProse` component that renders:

```tsx
<div className={`elves-draft__prose-row${empty ? ' elves-draft__prose-row--empty' : ''}`} data-testid="draft-para">
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
  </p>
</div>
```

Keep the unresolved-comment marker inside the `<p>`. The full-size edit button sits behind the text in CSS; the paragraph ignores pointer events while anchors opt back in. This makes prose clicks reach the edit button while links remain independent sibling content. In read-only mode the button is omitted and the paragraph resumes normal pointer events.

- [ ] **Step 4: Run component and model tests**

Run: `npm test -- tests/components/DraftPane.test.ts tests/model/draft.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the interaction slice**

```bash
git add src/components/DraftPane.tsx tests/components/DraftPane.test.ts tests/model/draft.test.ts
git commit -m "feat: render markdown links in draft prose"
```

### Task 3: Remove card chrome from the writing surface

**Files:**
- Modify: `src/components/draft.css`
- Modify: `e2e/draft.spec.ts`

- [ ] **Step 1: Add an end-to-end Markdown regression**

Add a Playwright test that creates `Read [Maggie](https://maggieappleton.com).`, opens the draft, verifies the rendered anchor, clicks the paragraph edit target, verifies the raw textarea value, exits editing, copies Markdown, and asserts the clipboard contains the exact source.

- [ ] **Step 2: Simplify draft styling**

Apply these concrete rules:

```css
.elves-draft,
.elves-draft__bar { background: #fff; }

.elves-draft__heading {
  font-size: 22px;
  line-height: 1.25;
  letter-spacing: -0.015em;
  margin: 42px 0 18px;
}

.elves-draft__prose-row,
.elves-draft__editor {
  width: 100%;
  margin: 0 0 15px;
}

.elves-draft__prose-row { position: relative; }
.elves-draft__edit-target {
  position: absolute;
  inset: 0;
  z-index: 0;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: text;
}
.elves-draft__para {
  position: relative;
  z-index: 1;
  margin: 0;
  pointer-events: none;
  white-space: pre-wrap;
  font-size: 16px;
  line-height: 1.72;
}
.elves-draft__link {
  pointer-events: auto;
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--elves-border-strong);
  text-underline-offset: 0.16em;
}
.elves-draft__prose-row:has(.elves-draft__edit-target:focus-visible),
.elves-draft__editor:focus-visible {
  outline: none;
  box-shadow: -2px 0 0 var(--elves-focus-ring);
}
.elves-draft__editor {
  padding: 0;
  color: var(--elves-ink);
  background: #fff;
  border: 0;
  border-radius: 0;
}
.elves-draft__figure,
.elves-draft__image-wrap {
  background: transparent;
  border: 1px dashed var(--elves-border);
  border-radius: 0;
}
.elves-draft__image {
  background: transparent;
  border-radius: 0;
}
```

Remove the old paragraph hover wash, gutter bleed, editor fill/full outline, and card-radius comments. Preserve existing typography, comment markers, figure metadata, reduced-motion handling, and responsive scrolling.

- [ ] **Step 3: Run focused tests and typecheck**

Run: `npm test -- tests/components/inlineMarkdown.test.ts tests/components/DraftPane.test.ts tests/model/draft.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Run the draft Playwright spec**

Run: `npx playwright test e2e/draft.spec.ts`

Expected: PASS. If localhost binding is denied in the sandbox, rerun with the required local permission rather than changing product code.

- [ ] **Step 5: Commit the visual slice**

```bash
git add src/components/draft.css e2e/draft.spec.ts
git commit -m "style: simplify the linear draft"
```

### Task 4: Verification, review, and PR

**Files:**
- Modify only files required by concrete review findings.

- [ ] **Step 1: Run all focused verification**

Run: `npm test -- tests/components/inlineMarkdown.test.ts tests/components/DraftPane.test.ts tests/model/draft.test.ts && npm run typecheck && npm run build`

Expected: PASS.

- [ ] **Step 2: Run the full Vitest suite**

Run: `npm test`

Expected: PASS outside the restricted sandbox. Compare any failure with the recorded baseline; do not attribute localhost `port` failures to this change.

- [ ] **Step 3: Request independent code and design review**

Review the branch diff against the design spec for parser safety, exact Markdown preservation, nested-interaction accessibility, keyboard focus, visual minimalism, and unintended changes to figure/image ordering.

- [ ] **Step 4: Fix every actionable review finding and rerun affected tests**

Use a new red test for behavioural findings. For CSS-only findings, make the smallest rule change and rerun component tests, typecheck, and build.

- [ ] **Step 5: Push and open the pull request**

```bash
git push -u origin feat/minimal-draft-markdown-links
gh pr create --base main --head feat/minimal-draft-markdown-links --title "Simplify the linear draft and render Markdown links" --body-file /tmp/elves-minimal-draft-pr.md
```

The PR body must summarise the plain writing surface, safe link rendering with raw Markdown preservation, tests run, and any baseline-only sandbox limitation.
