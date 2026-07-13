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

test('comments reserve a 24px gap before the next card', async ({ page, request }) => {
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

  const comments = page.locator(`[data-shape-id="${firstCardId}"] .elves-comments`)
  const nextCard = page.locator(`[data-shape-id="${secondCardId}"] .elves-card`)
  await expect(comments).toBeVisible()
  await expect.poll(async () => {
    const commentsBox = await comments.boundingBox()
    const nextCardBox = await nextCard.boundingBox()
    if (!commentsBox || !nextCardBox) return null
    return Math.round(nextCardBox.y - (commentsBox.y + commentsBox.height))
  }).toBe(24)
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
  const [cardId] = await serverCardIds(request, projectId)
  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-${Date.now()}-second`,
      author: 'claude',
      ops: [{ kind: 'add_comment', cardId, comment: { type: null, text: 'second note' } }],
    },
  })

  const comment = page.locator('.elves-comment')
  await expect(comment).toHaveCount(2)
  const resolveFirst = page.getByRole('button', { name: /^Resolve comment 1 of 2 on card \d+ of \d+: freeform note$/ })
  const resolveSecond = page.getByRole('button', { name: /^Resolve comment 2 of 2 on card \d+ of \d+: second note$/ })
  await expect(resolveFirst).toHaveCount(1)
  await expect(resolveSecond).toHaveCount(1)
  await resolveFirst.click()
  await expect(comment).toHaveCount(1)
  await page.getByRole('button', { name: /^Resolve comment 1 of 1 on card \d+ of \d+: second note$/ }).click()
  await expect(page.locator('.elves-comment')).toHaveCount(0)
})

test('identical comments on different cards have distinct resolve controls', async ({ page, request }) => {
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

  const controls = page.getByRole('button', {
    name: /^Resolve comment 1 of 1 on card \d+ of \d+: duplicate note$/,
  })
  await expect(controls).toHaveCount(2)
  const labels = await controls.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(new Set(labels).size).toBe(2)
})
