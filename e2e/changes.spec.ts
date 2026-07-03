import { test, expect } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

async function cardById(request: any, id: string): Promise<any> {
  const res = await request.get(`${BASE}/projects/${projectId}/canvas`)
  const snap = await res.json()
  const records = Object.values(snap.document?.store ?? snap.document?.records ?? {})
  return records.find((r: any) => r.id === id)
}

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('move_cards repositions a card and one Ctrl-Z reverts it', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-note').click()
  // Wait until the card is persisted so the change-set cross-check is satisfied.
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [id] = await serverCardIds(request, projectId)
  const before = await cardById(request, id)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: 'm1', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: id, x: before.x + 500, y: before.y }] }] },
  })
  // Poll the persisted position rather than guessing at the save delay.
  await expect.poll(async () => Math.round((await cardById(request, id))?.x ?? 0)).toBe(Math.round(before.x + 500))

  await page.keyboard.press('Control+z')
  await expect.poll(async () => Math.round((await cardById(request, id))?.x ?? 0)).toBe(Math.round(before.x))
})

test('merge_notes hides duplicates under the representative and marks provenance', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-note').click()
  await page.getByTestId('new-note').click()
  // Both cards must be persisted before the merge (cross-check references both ids).
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const ids = await serverCardIds(request, projectId)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: 'mg1', author: 'claude', ops: [{ kind: 'merge_notes', cardIds: ids }] },
  })

  // representative shows the merged badge; exactly one visible note card remains
  await expect(page.getByTestId('merged-badge')).toBeVisible()
  await expect(page.locator('.elves-card--note:visible')).toHaveCount(1)
  // Poll for the persisted provenance (the client save of the merge is async).
  await expect.poll(async () => (await cardById(request, ids[1]))?.props?.mergedInto).toBe(ids[0])

  // Ctrl-Z restores the duplicate
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('merged-badge')).toHaveCount(0)
})
