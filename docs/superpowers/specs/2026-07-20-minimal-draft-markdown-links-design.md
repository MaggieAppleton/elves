# Minimal Draft and Markdown Links Design

## Goal

Make the linear draft feel like a plain writing document rather than a stack of cards. Prose should sit directly on a white page, editing should not introduce a dark fill or outlined box, section headings should read as headings, and figures and images should keep only enough framing to show that they are distinct draft elements.

Prose may contain standard Markdown links in the form `[label](https://example.com)`. The reading view renders the label as a normal clickable link. Editing reveals and preserves the raw Markdown, and Copy as Markdown exports the same source text unchanged.

## Chosen approach

Use a small, link-only inline Markdown parser in the client and simplify the existing draft CSS. This fits the current architecture: prose already lives as plain text in `CardShape.props.text`, the draft editor writes that exact string back to the canvas, and `draftToMarkdown()` already exports it verbatim.

Two alternatives were considered:

1. CSS-only, leaving `[label](url)` visible in the reading view. This is the smallest change but does not provide the requested WYSIWYG-like experience.
2. A full Markdown or rich-text editor. This would support more syntax, but it would also add selection, serialisation, paste, IME, and character-attribution complexity that is unnecessary for link-only support.

The focused parser gives links a polished reading state without changing the stored data or prematurely choosing a rich-text framework.

## Reading and editing interaction

In reading mode, prose is rendered as text plus link tokens. Safe links become underlined anchors; everything else remains literal text. Clicking a link follows it without opening the prose editor. Clicking elsewhere in the prose opens the existing textarea, with the exact raw Markdown source and the caret at the end. Blurring or pressing Escape returns to reading mode.

The prose edit target and anchors must remain separate interactive elements. The implementation will avoid putting anchors inside an element with `role="button"`; mouse and keyboard editing will instead be exposed through sibling semantics within one visually plain prose row. This keeps link navigation and paragraph editing independently usable by keyboard and assistive technology.

Links open in a new tab with `rel="noreferrer"`, so following a reference does not discard an in-progress draft. The first version recognises absolute `http:`, `https:`, and `mailto:` destinations. Unsafe or malformed destinations, including `javascript:`, remain visible as literal Markdown and are never placed in an `href`.

## Visual treatment

The draft pane and toolbar use a white paper surface. The reading column remains narrow enough for comfortable prose but loses the gutter-bleeding paragraph boxes, rounded corners, hover washes, and card-like borders.

The textarea uses the same width, type size, line height, spacing, and white background as the paragraph it replaces. It has no border, fill, or radius. A restrained focus indicator remains for keyboard users, but it should not look like a selected card.

Section headings increase from 15px to approximately 22px, with a tighter line height and clearer spacing from the preceding prose. Prose stays at 16px with the existing generous line height.

Figures and image wrappers use a transparent white background with a faint dashed border. Images lose their secondary background and rounded card treatment. Figure metadata remains readable but quiet. The existing status pill may remain because it communicates state rather than card selection.

## Data flow and boundaries

No draft schema, persistence, server, or MCP changes are required:

1. `DraftPane` receives the existing prose string from `compileDraft()`.
2. A pure client helper tokenises safe Markdown links for the reading view.
3. `ProseEditor` continues editing `CardShape.props.text` directly and reattributes the exact new string.
4. `draftToMarkdown()`, server `/draft`, and MCP `read_draft` continue receiving and returning the original text.

Keeping parsing out of `src/model/draft.ts` is deliberate. The shared draft compiler owns ordering and export; link tokenisation is a presentation concern used only by the client.

## Testing

Pure unit tests will cover plain text, multiple links, adjacent punctuation, malformed syntax, and unsafe schemes. Component tests will cover rendered link labels and destinations, literal unsafe Markdown, link clicks not entering edit mode, paragraph activation entering edit mode, and raw Markdown appearing unchanged in the textarea. Model tests will explicitly lock in verbatim Markdown export.

The existing draft component tests and TypeScript check form the fast verification loop. The final pass will also run the broader suite and the draft Playwright flow. Server tests that bind localhost may need to run outside the sandbox; the clean baseline already shows the known `Cannot read properties of null (reading 'port')` failure pattern when binding is denied.

## Out of scope

Bold, italic, headings inside prose cards, inline images, nested Markdown constructs, link editing popovers, and a full rich-text toolbar are not part of this change. The parser can be extended later if another Markdown feature is explicitly needed.
