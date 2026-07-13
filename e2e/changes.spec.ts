import { test, expect } from '@playwright/test'
import { readSelectionTool } from '../mcp/tools'
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

test('move_cards repositions the visible card after editing ends', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-note').click()
  // Wait until the card is persisted so the change-set cross-check is satisfied.
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [id] = await serverCardIds(request, projectId)
  const before = await cardById(request, id)
  const card = page.locator(`[data-shape-id="${id}"]`)
  const beforeBox = await card.boundingBox()
  expect(beforeBox).not.toBeNull()
  await page.keyboard.press('Escape')

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: 'm1', author: 'claude', ops: [{ kind: 'move_cards', moves: [{ cardId: id, x: before.x + 500, y: before.y }] }] },
  })
  // The server persists the move, then the browser loads that authoritative
  // snapshot once editing has ended.
  await expect.poll(async () => Math.round((await cardById(request, id))?.x ?? 0)).toBe(Math.round(before.x + 500))
  await expect.poll(async () => Math.round((await card.boundingBox())?.x ?? 0)).toBe(Math.round(beforeBox!.x + 500))
})

test('merge_notes hides duplicates under the representative and marks provenance', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')
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

  // The merged card is truly hidden — no invisible "ghost" shape left behind.
  // Only the representative renders (its stack/fan-out live inside its own shape).
  await expect(page.locator('.tl-shape')).toHaveCount(1)

  // A stack peeks out behind the representative to signal "there's more here".
  await expect(page.getByTestId('merge-stack')).toBeVisible()

  // Clicking the badge fans the merged card out to the right, read-only; the
  // stack gives way to the fan. Clicking again collapses it back.
  await expect(page.getByTestId('merge-fan')).toHaveCount(0)
  await page.getByTestId('merged-badge').click()
  await expect(page.getByTestId('merge-fan')).toBeVisible()
  await expect(page.getByTestId('merge-fan-card')).toHaveCount(1)
  await expect(page.getByTestId('merge-stack')).toHaveCount(0)
  await page.getByTestId('merged-badge').click()
  await expect(page.getByTestId('merge-fan')).toHaveCount(0)

})

test('deleting a merged card from the fan-out removes it permanently', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-note').click()
  await page.getByTestId('new-note').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const ids = await serverCardIds(request, projectId)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: 'mg2', author: 'claude', ops: [{ kind: 'merge_notes', cardIds: ids }] },
  })
  // Reload so the client loads the merged state from disk: this test is about
  // deleting a merged card, not about realtime delivery of the merge, so we
  // reach the merged state deterministically rather than waiting on the push.
  await page.reload()
  await expect(page.getByTestId('merged-badge')).toBeVisible()
  await expect.poll(async () => (await cardById(request, ids[1]))?.props?.mergedInto).toBe(ids[0])

  // Open the fan-out and delete the single merged member.
  await page.getByTestId('merged-badge').click()
  await expect(page.getByTestId('merge-fan-card')).toHaveCount(1)
  await page.getByTestId('delete-merged-card').click()

  // The merged card is gone from the server, and with no members left the
  // representative reverts to a plain note (badge disappears).
  await expect.poll(async () => await cardById(request, ids[1])).toBeFalsy()
  await expect(page.getByTestId('merged-badge')).toHaveCount(0)
  await expect(page.locator('.elves-card--note:visible')).toHaveCount(1)
})

test('the merged-card fan finds clear space instead of blocking its neighbour', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < 3; i++) {
    await page.getByTestId('new-note').click()
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(3)
  const ids = await serverCardIds(request, projectId)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `merge-layout-${Date.now()}`,
      author: 'claude',
      ops: [
        {
          kind: 'move_cards',
          moves: [
            { cardId: ids[0], x: 300, y: 300 },
            { cardId: ids[1], x: 300, y: 450 },
            { cardId: ids[2], x: 694, y: 300 },
          ],
        },
        { kind: 'merge_notes', cardIds: [ids[0], ids[1]] },
      ],
    },
  })

  const representative = page.locator(`[data-shape-id="${ids[0]}"]`)
  const neighbour = page.locator(`[data-shape-id="${ids[2]}"]`)
  await page.mouse.click(1100, 600)
  await representative.getByTestId('merged-badge').click()
  const fan = representative.getByTestId('merge-fan')
  await expect(fan).toBeVisible()

  const geometry = await page.evaluate(({ representativeId, neighbourId }) => {
    const fanElement = document.querySelector(`[data-shape-id="${representativeId}"] [data-testid="merge-fan"]`)
    const neighbourElement = document.querySelector(`[data-shape-id="${neighbourId}"] .elves-card`)
    if (!fanElement || !neighbourElement) return null
    const fanBox = fanElement.getBoundingClientRect()
    const neighbourBox = neighbourElement.getBoundingClientRect()
    const intersects = fanBox.left < neighbourBox.right && fanBox.right > neighbourBox.left &&
      fanBox.top < neighbourBox.bottom && fanBox.bottom > neighbourBox.top
    return {
      intersects,
      clickX: neighbourBox.left + 30,
      clickY: neighbourBox.top + 30,
    }
  }, { representativeId: ids[0], neighbourId: ids[2] })

  expect(geometry?.intersects).toBe(false)
  if (!geometry) throw new Error('merge fan or neighbour missing')
  await page.mouse.click(geometry.clickX, geometry.clickY)
  await expect
    .poll(async () => (await readSelectionTool(BASE)).selection.map((selection) => selection.id), { timeout: 15000 })
    .toEqual([ids[2]])
  await expect(neighbour).toBeVisible()
})
