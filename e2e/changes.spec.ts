import { test, expect } from '@playwright/test'

const BASE = 'http://localhost:5199'

async function cardIds(request: any): Promise<string[]> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records.filter((r: any) => r.typeName === 'shape' && r.type === 'card').map((r: any) => r.id)
}
async function cardById(request: any, id: string): Promise<any> {
  const res = await request.get(`${BASE}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records.find((r: any) => r.id === id)
}

test.beforeEach(async ({ request }) => {
  await request.post(`${BASE}/canvas`, { data: { document: null, session: null } })
})

test('move_cards repositions a card and one Ctrl-Z reverts it', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-source').click()
  await page.waitForTimeout(800)
  const [id] = await cardIds(request)
  const before = await cardById(request, id)

  await request.post(`${BASE}/changeset`, {
    data: { id: 'm1', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: id, x: before.x + 500, y: before.y }] }] },
  })
  await page.waitForTimeout(800)
  expect((await cardById(request, id)).x).toBeCloseTo(before.x + 500, 0)

  await page.keyboard.press('Control+z')
  await page.waitForTimeout(800)
  expect((await cardById(request, id)).x).toBeCloseTo(before.x, 0)
})

test('merge_sources hides duplicates under the representative and marks provenance', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-source').click()
  await page.getByTestId('new-source').click()
  await page.waitForTimeout(800)
  const ids = await cardIds(request)
  expect(ids.length).toBe(2)

  await request.post(`${BASE}/changeset`, {
    data: { id: 'mg1', author: 'claude', ops: [{ kind: 'merge_sources', cardIds: ids }] },
  })

  // representative shows the merged badge; exactly one visible source card remains
  await expect(page.getByTestId('merged-badge')).toBeVisible()
  await expect(page.locator('.elves-card--source:visible')).toHaveCount(1)
  expect((await cardById(request, ids[1])).props.mergedInto).toBe(ids[0])

  // Ctrl-Z restores the duplicate
  await page.keyboard.press('Control+z')
  await page.waitForTimeout(300)
  await expect(page.getByTestId('merged-badge')).toHaveCount(0)
})
