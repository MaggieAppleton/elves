import { test, expect, type Page } from '@playwright/test'
import { createQuestionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

// A card's box height must always grow to fit its text: no clipping, no inner
// scroll container. These are regression tests for the autosize measurement,
// which once measured the text column too wide (it ignored the card's 1px
// border, box-sizing:border-box) and so under-counted by a whole wrapped line —
// the card was born too short and clipped its last line / scrolled inside.
const LONG = `Once you have the shape of the story mapped out, and all your major plot points in roughly the right position, it's time to move into a linear flow.

Because eventually, all writing has to become a linear experience. Unless you are into experimental, multiverse structures, which is not personally my thing.`

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

// scrollHeight > clientHeight means content overflows the box — the bug.
async function overflow(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    return el.scrollHeight - el.clientHeight
  }, selector)
}

for (const kind of ['note', 'prose'] as const) {
  test(`${kind} card grows to fit long multi-paragraph text (no clip)`, async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

    await page.getByTestId(kind === 'note' ? 'new-note' : 'new-prose').click()
    const card = page.locator(`.elves-card--${kind}`).first()
    await expect(card).toBeVisible()

    // A new note isn't in editing; a new prose is. Double-click to be sure the
    // editor is open, then fill and commit.
    const box = await card.boundingBox()
    if (!box) throw new Error('card not in DOM')
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 20)
    await page.locator('.elves-card__editor').fill(LONG)
    await page.mouse.click(50, 50) // commit + exit edit
    await page.waitForTimeout(400)

    // Read mode: the card box must fully contain its text.
    expect(await overflow(page, `.elves-card--${kind}`)).toBe(0)
  })
}

test('question card is default card width and grows to fit long text (no clip)', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  // Prove the canvas is loaded so the MCP create isn't dropped (issue #9).
  await page.getByTestId('new-prose').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  await page.keyboard.press('Escape')

  await createQuestionTool(BASE, projectId, { text: LONG, x: 400, y: 200 })
  const question = page.locator('.elves-question').first()
  await expect(question).toBeVisible()

  // Widened to the shared card default width (370).
  const w = await question.evaluate((el) => Math.round(el.getBoundingClientRect().width))
  expect(w).toBe(370)

  // And its box fully contains the text.
  expect(await overflow(page, '.elves-question')).toBe(0)
})
