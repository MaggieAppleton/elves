import { test, expect, type Page } from '@playwright/test'
import { createQuestionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

// Zoom out until BOTH a card's gist and a question's gist are visible. Mirrors
// zoomOutUntilGist in gist-overflow.spec.ts: tldraw only zooms on a CTRL+wheel
// event, and Playwright's mouse.wheel can't set that ctrlKey flag, so the wheel
// event is dispatched by hand toward the canvas centre. Poll rather than assume
// a single tick crosses the GIST_ZOOM (0.6) threshold.
async function zoomOutUntilGists(page: Page) {
  const cardGist = page.getByTestId('card-gist').first()
  const questionGist = page.locator('[data-testid="question-text"][data-gist="true"]').first()
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      const canvas = document.querySelector('.tl-canvas') || document.querySelector('.tl-container')
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 60, ctrlKey: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }))
    })
    await page.waitForTimeout(100)
    if (
      (await cardGist.isVisible().catch(() => false)) &&
      (await questionGist.isVisible().catch(() => false))
    ) {
      break
    }
  }
  await expect(cardGist).toBeVisible()
  await expect(questionGist).toBeVisible()
}

test('a summarized question shows its gist when zoomed out, like a card', async ({ page, request }) => {
  await page.goto('/')
  // Cold-start compile of the app module graph can exceed 15s on a fresh vite
  // dev server, so give the canvas generous headroom on first paint.
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 45000 })

  // A summarized prose card, so there is a known-good card gist to compare
  // the question's gist font-size against at the same zoom.
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill(
    'Canvases and agents provide new ways to interact with tools effectively.',
  )
  await page.mouse.click(50, 50) // commit

  // Wait for the card to persist, so the question-summary change-set's
  // cross-check (and the MCP create_question call) land against a loaded canvas
  // (the #9 race: a change-set applied before load is dropped on purpose).
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)

  // Give the prose card a model summary directly, the same way comments.spec.ts
  // posts a change-set — there's no MCP tool for set_summary either.
  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-card-${Date.now()}`,
      author: 'claude',
      ops: [{
        kind: 'set_summary',
        cardId,
        summary: 'Agents open new interaction modes for tools.',
        summaryOfHash: 'irrelevant-for-this-test',
        summaryBy: 'claude',
        summaryAt: new Date().toISOString(),
      }],
    },
  })

  // Seed a question via the MCP tool (its shape id is only known once created),
  // then look it up on the map to target set_question_summary at it.
  await createQuestionTool(BASE, projectId, { text: 'What did the room smell like?', x: 500, y: 400 })
  const map = await (await request.get(`${BASE}/projects/${projectId}/map`)).json()
  const question = map.questions.find((q: { text: string }) => q.text === 'What did the room smell like?')
  if (!question) throw new Error('question not found on map')

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-question-${Date.now()}`,
      author: 'claude',
      ops: [{
        kind: 'set_question_summary',
        questionId: question.id,
        summary: 'The smell of the room',
        summaryOfHash: 'irrelevant-for-this-test',
        summaryBy: 'claude',
        summaryAt: new Date().toISOString(),
      }],
    },
  })

  // The realtime websocket push may not reach the browser in every environment
  // this runs in; reload to force a load-from-disk of both change-sets above.
  await page.reload()
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 45000 })

  await zoomOutUntilGists(page)

  const questionGist = page.locator('[data-testid="question-text"][data-gist="true"]').first()
  await expect(questionGist).toHaveText('The smell of the room')

  // The gist's font is counter-scaled UP with zoom (toward the cap) but then
  // FITTED to the question's box — which, unlike a card, always reserves its
  // header row. So the gist must sit fully inside the question box: its bottom
  // edge no lower than the box's. This is the regression guard for the header
  // reservation — before the fit reserved the header row, a short question's
  // enlarged gist rendered at the cap and spilled out (questions have no
  // overflow:hidden). Its size is a legible enlargement of the 14px body text.
  const box = page.locator('.elves-question').first()
  const boxRect = await box.boundingBox()
  const gistRect = await questionGist.boundingBox()
  if (!boxRect || !gistRect) throw new Error('question box or gist not in DOM')
  expect(gistRect.y + gistRect.height).toBeLessThanOrEqual(boxRect.y + boxRect.height + 1)

  const questionFontSize = await questionGist.evaluate((el) =>
    parseFloat(getComputedStyle(el).fontSize),
  )
  expect(questionFontSize).toBeGreaterThan(14) // enlarged above the body-text size
})
