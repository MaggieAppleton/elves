import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

async function firstCardId(request: any): Promise<string> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  const card: any = records.find((r: any) => r.typeName === 'shape' && r.type === 'card')
  return card.id
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('an injected comment renders on the card, then resolves away', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()
  await page.waitForTimeout(800) // let the card persist so we can read its id

  const cardId = await firstCardId(request)
  await request.post(`${BASE}/changeset`, {
    data: { id: 'cs1', author: 'claude', ops: [
      { kind: 'add_comment', cardId, comment: { type: 'needs-evidence', text: 'no source yet' } },
    ] },
  })

  const pin = page.locator('.elves-comment[data-type="needs-evidence"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('no source yet')

  // one Ctrl-Z reverts Claude's change
  await page.keyboard.press('Control+z')
  await expect(page.locator('.elves-comment')).toHaveCount(0)

  // re-inject and resolve instead
  await request.post(`${BASE}/changeset`, {
    data: { id: 'cs2', author: 'claude', ops: [
      { kind: 'add_comment', cardId, comment: { type: null, text: 'freeform note' } },
    ] },
  })
  await expect(page.locator('.elves-comment')).toHaveCount(1)
  await page.getByTestId('comment-resolve').first().click()
  await expect(page.locator('.elves-comment')).toHaveCount(0)
})
