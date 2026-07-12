import { test, expect } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

async function addCardAndComment(page: any, request: any, comment: { type: string | null; text: string }) {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()

  // Wait until the card is actually persisted, so the change-set's cross-check
  // (card must live in the project) is satisfied deterministically.
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)
  await page.keyboard.press('Escape')

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: `cs-${Date.now()}`, author: 'claude', ops: [{ kind: 'add_comment', cardId, comment }] },
  })
}

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test("Claude's injected comment renders on the card and is one Ctrl-Z away from gone", async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'no source yet' })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('no source yet')

  // A single Ctrl-Z reverts Claude's change.
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-comment')).toHaveCount(0)
})

test('a freeform comment can be resolved away', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: null, text: 'freeform note' })

  const comment = page.locator('.elves-comment')
  await expect(comment).toHaveCount(1)
  await comment.getByRole('button', { name: 'Resolve comment' }).click()
  await expect(page.locator('.elves-comment')).toHaveCount(0)
})
