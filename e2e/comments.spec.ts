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

async function addTwoComments(page: any, request: any) {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'The opening needs a source.' })
  const [cardId] = await serverCardIds(request, projectId)
  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-${Date.now()}-second`,
      author: 'claude',
      ops: [{ kind: 'add_comment', cardId, comment: { type: 'structure', text: 'The ending needs a clearer bridge.' } }],
    },
  })
}

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('comments do not reserve a marker row before the next card', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const [firstCardId, secondCardId] = await serverCardIds(request, projectId)
  const card = page.locator(`[data-shape-id="${firstCardId}"] .elves-card`)
  const nextCard = page.locator(`[data-shape-id="${secondCardId}"] .elves-card`)
  await expect(card).toBeVisible()
  const beforeCard = await card.boundingBox()
  const beforeNextCard = await nextCard.boundingBox()
  expect(beforeCard).not.toBeNull()
  expect(beforeNextCard).not.toBeNull()
  const beforeGap = Math.round(beforeNextCard!.y - (beforeCard!.y + beforeCard!.height))

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

  await expect(page.getByTestId('annotation-pin')).toHaveCount(2)
  await expect.poll(async () => {
    const cardBox = await card.boundingBox()
    const nextCardBox = await nextCard.boundingBox()
    if (!cardBox || !nextCardBox) return null
    return Math.round(nextCardBox.y - (cardBox.y + cardBox.height))
  }).toBe(beforeGap)
})

test("Claude's injected comment renders as a pin and is one Ctrl-Z away from gone", async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'no source yet' })

  const pin = page.getByTestId('annotation-pin')
  await expect(pin).toBeVisible()
  await expect(pin).toHaveAttribute('data-type', 'needs-evidence')

  // A single Ctrl-Z reverts Claude's change.
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('annotation-pin')).toHaveCount(0)
})

test('each open card comment renders an independent pin', async ({ page, request }) => {
  await addTwoComments(page, request)

  const pins = page.getByTestId('annotation-pin')
  await expect(pins).toHaveCount(2)
  const boxes = await pins.evaluateAll((elements) => elements.map((pin) => pin.getBoundingClientRect().y))
  expect(new Set(boxes).size).toBe(2)
})

test('identical comments on different cards have distinct pins', async ({ page, request }) => {
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

  const pins = page.getByTestId('annotation-pin')
  await expect(pins).toHaveCount(2)
  await expect(page.locator(`[data-shape-id="${firstCardId}"] [data-testid="annotation-pin"]`)).toHaveCount(1)
  await expect(page.locator(`[data-shape-id="${secondCardId}"] [data-testid="annotation-pin"]`)).toHaveCount(1)
})

test('focus exposes a complete thread without opening the rail', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'A comment that must become a marker.' })

  const pin = page.getByTestId('annotation-pin')
  await pin.focus()
  const popover = page.getByTestId('annotation-popover')
  await expect(popover).toBeVisible()
  await expect(popover).toContainText('A comment that must become a marker.')
  // Shape children are indexed only within their transformed `.tl-shape`
  // parent. The expanded thread must instead be in tldraw's front canvas layer.
  expect(await popover.evaluate((element) => element.closest('.tl-shape'))).toBeNull()
  const stacking = await popover.evaluate((element) => ({
    popover: Number(getComputedStyle(element.parentElement!).zIndex),
    shapes: Number(getComputedStyle(document.querySelector('.tl-shapes')!).zIndex),
  }))
  expect(stacking.popover).toBeGreaterThan(stacking.shapes)
  await expect(page.getByTestId('annotation-rail')).toHaveCount(0)
})

test('Tab from a pin reaches that pin’s front-layer thread before another canvas annotation', async ({ page, request }) => {
  await addTwoComments(page, request)

  const pins = page.getByTestId('annotation-pin')
  await pins.nth(0).focus()
  await page.keyboard.press('Tab')

  await expect(page.getByTestId('annotation-popover').getByLabel('Reply to annotation')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(pins.nth(0)).toBeFocused()
})

test('a mouse can travel from a pin into its hover popover and use the reply controls', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Keep the hover controls reachable.' })

  const pin = page.getByTestId('annotation-pin')
  const popover = page.getByTestId('annotation-popover')
  await pin.hover()
  await expect(popover).toBeVisible()
  const box = await pin.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x - 2, box!.y + box!.height / 2)
  await expect(popover).toBeVisible()
  await popover.getByLabel('Reply to annotation').fill('Can you make this source more specific?')
  await popover.getByRole('button', { name: 'Send reply' }).click()
  await expect(popover.getByRole('button', { name: 'Replying…' })).toBeDisabled()
})

test('a resolved card thread can be reopened from Review and restored', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Keep this thread recoverable.' })

  await page.getByTestId('annotation-pin').click()
  const rail = page.getByTestId('annotation-rail')
  await rail.getByRole('button', { name: /^Resolve .* comment$/ }).click()
  await expect(page.getByTestId('annotation-pin')).toHaveCount(0)

  const restoreFromReview = page.getByRole('button', { name: 'Restore annotation: Keep this thread recoverable.' })
  await expect(restoreFromReview).toBeVisible()
  await restoreFromReview.click()
  await expect(rail.getByRole('button', { name: /^Restore .* comment$/ })).toBeVisible()
  await rail.getByRole('button', { name: /^Restore .* comment$/ }).click()
  await expect(page.getByTestId('annotation-pin')).toBeVisible()
})

test('attached comment pins remain compact at overview zoom', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'A comment that must become a marker.' })
  await page.getByRole('button', { name: /Zoom — 100%/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()

  await expect(page.getByTestId('annotation-pin')).toHaveCount(1)
  await expect(page.getByTestId('annotation-pin')).toHaveCSS('width', '28px')
})

test('closing an annotation rail restores split view', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'This needs a source.' })

  await page.getByTestId('draft-open').click()
  await expect(page.getByTestId('draft-divider')).toBeVisible()
  await page.getByTestId('annotation-pin').click()
  await expect(page.getByTestId('annotation-rail')).toBeVisible()
  await expect(page.getByTestId('annotation-rail')).toContainText('This needs a source.')
  await page.getByRole('button', { name: 'Close annotation' }).click()
  await expect(page.getByTestId('draft-divider')).toBeVisible()
})

test('an annotation reply streams then persists Claude’s answer', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'This claim needs a source.' })

  await page.getByTestId('annotation-pin').click()
  const rail = page.getByTestId('annotation-rail')
  const reply = 'Which source should support this claim?'
  await rail.getByLabel('Reply to annotation').fill(reply)
  await rail.getByRole('button', { name: 'Send reply' }).click()

  await expect(rail).toContainText(reply)
  await expect(rail).toContainText('Stub is checking likely sources…')
  await expect(rail.getByRole('button', { name: 'Replying…' })).toBeDisabled()
  await expect(rail).toContainText('Stub annotation reply: Which source should support this claim?')
  const nextReply = rail.getByLabel('Reply to annotation')
  await expect(nextReply).toBeEnabled()
  await nextReply.fill('Please suggest the strongest source.')
  await expect(rail.getByRole('button', { name: 'Send reply' })).toBeEnabled()

  const [cardId] = await serverCardIds(request, projectId)
  await expect.poll(async () => {
    const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
    const card = (snapshot.document?.store ?? snapshot.document?.records ?? {})[cardId]
    return card?.props?.comments?.[0]?.messages?.map((message: { author: string; text: string }) => `${message.author}:${message.text}`)
  }).toEqual([
    'claude:This claim needs a source.',
    'user:Which source should support this claim?',
    'claude:Stub annotation reply: Which source should support this claim?',
  ])
})
