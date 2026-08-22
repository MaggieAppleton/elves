import { test, expect } from '@playwright/test'
import { CANVAS_GAP } from '../src/model/layout'
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

test('comments reserve a full gap before the next card', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const [firstCardId, secondCardId] = await serverCardIds(request, projectId)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `layout-comments-${Date.now()}`,
      author: 'claude',
      ops: [
        {
          kind: 'add_comment', cardId: firstCardId,
          comment: {
            type: 'structure',
            text: 'This comment deliberately adds enough detail to occupy multiple lines beneath the first card and expose its real layout footprint.',
          },
        },
        {
          kind: 'add_comment', cardId: firstCardId,
          comment: {
            type: 'needs-evidence',
            text: 'A second annotation makes the hidden overflow footprint taller than the nominal card body.',
          },
        },
      ],
    },
  })

  const marker = page.locator(`[data-shape-id="${firstCardId}"] [data-testid="annotation-marker"]`)
  const nextCard = page.locator(`[data-shape-id="${secondCardId}"] .elves-card`)
  await expect(marker).toBeVisible()
  await expect.poll(async () => {
    const markerBox = await marker.boundingBox()
    const nextCardBox = await nextCard.boundingBox()
    if (!markerBox || !nextCardBox) return null
    return Math.round(nextCardBox.y - (markerBox.y + markerBox.height))
  }).toBe(CANVAS_GAP)
})

test("Claude's injected comment renders as a marker and is one Ctrl-Z away from gone", async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'no source yet' })

  const pin = page.getByTestId('annotation-marker')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('no source yet')

  // A single Ctrl-Z reverts Claude's change.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('annotation-marker')).toHaveCount(0)
})

test('multiple freeform comments collapse into one marker with a count', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: null, text: 'freeform note' })
  const [cardId] = await serverCardIds(request, projectId)
  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-${Date.now()}-second`,
      author: 'claude',
      ops: [{ kind: 'add_comment', cardId, comment: { type: null, text: 'second note' } }],
    },
  })

  const marker = page.getByTestId('annotation-marker')
  await expect(marker).toHaveCount(1)
  await expect(marker).toContainText('+1')
  await expect(page.locator('.elves-comment__resolve')).toHaveCount(0)
})

test('identical comments on different cards have distinct markers', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const [firstCardId, secondCardId] = await serverCardIds(request, projectId)

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `duplicate-comments-${Date.now()}`,
      author: 'claude',
      ops: [
        { kind: 'add_comment', cardId: firstCardId, comment: { type: null, text: 'duplicate note' } },
        { kind: 'add_comment', cardId: secondCardId, comment: { type: null, text: 'duplicate note' } },
      ],
    },
  })

  const markers = page.getByTestId('annotation-marker')
  await expect(markers).toHaveCount(2)
  await expect(page.locator(`[data-shape-id="${firstCardId}"] [data-testid="annotation-marker"]`)).toHaveCount(1)
  await expect(page.locator(`[data-shape-id="${secondCardId}"] [data-testid="annotation-marker"]`)).toHaveCount(1)
})

test('attached comments collapse to one marker and do not expose full bodies at overview zoom', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'A comment that must become a marker.' })
  await page.getByRole('button', { name: /Zoom — 100%/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()

  await expect(page.getByTestId('annotation-marker')).toHaveCount(1)
  await expect(page.locator('.elves-comment__text')).toHaveCount(0)
})

test('closing an annotation rail restores split view', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'This needs a source.' })

  await page.getByTestId('draft-open').click()
  await expect(page.getByTestId('draft-divider')).toBeVisible()
  await page.getByTestId('annotation-marker').click()
  await expect(page.getByTestId('annotation-rail')).toBeVisible()
  await expect(page.getByTestId('annotation-rail')).toContainText('This needs a source.')
  await page.getByRole('button', { name: 'Close annotation' }).click()
  await expect(page.getByTestId('draft-divider')).toBeVisible()
})
