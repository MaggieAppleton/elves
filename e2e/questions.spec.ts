import { test, expect } from '@playwright/test'
import { createQuestionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

// Establish that the tab's canvas has fully loaded before firing an MCP call: a
// change-set applied before load is dropped on purpose (App's canvasLoadedRef,
// the #9 race). Creating a card in the UI and waiting for it to persist proves
// the canvas is loaded (a UI edit only saves once loaded) and gives the project
// a real document so the MCP create lands server-side too.
async function canvasReady(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
}

test('an MCP create_question tool call renders an orange, Claude-marked question', async ({ page, request }) => {
  await canvasReady(page, request)

  await createQuestionTool(BASE, projectId, { text: 'What did the room smell like?', x: 400, y: 200 })

  const question = page.locator('.elves-question', { hasText: 'What did the room smell like?' })
  await expect(question).toBeVisible()
  await expect(question).toHaveAttribute('data-authored-by', 'claude')
  // Authored by Claude → its mark is present.
  await expect(question.getByTestId('question-agent-mark')).toHaveAttribute('data-agent', 'claude')
})

test('dismissing a question hides it (recoverable in-file, but gone from the canvas)', async ({ page, request }) => {
  await canvasReady(page, request)

  await createQuestionTool(BASE, projectId, { text: 'Why should a novice care?', x: 400, y: 200 })

  const question = page.locator('.elves-question', { hasText: 'Why should a novice care?' })
  await expect(question).toBeVisible()

  // The dismiss control (✓) opts into pointer events even though the shape body
  // doesn't, so it's directly clickable (revealed on hover/selection in the app).
  await question.getByTestId('question-dismiss').click()

  // Dismissed = hidden from render and hit-testing.
  await expect(page.locator('.elves-question')).toHaveCount(0)

  // Recoverable, not deleted: the dismissed question persists on disk (via the
  // debounced save), so read_map still returns it — dismissed. Poll to let the
  // save land.
  await expect
    .poll(async () => {
      const map = await (await request.get(`${BASE}/projects/${projectId}/map`)).json()
      return map.questions
    })
    .toEqual([expect.objectContaining({ text: 'Why should a novice care?', dismissed: true })])
})
