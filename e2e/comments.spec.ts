import { test, expect } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'
import { createFeedbackTool, createNoteCardTool, deleteCardTool, moveCardsTool, readMapTool } from '../mcp/tools'

let projectId: string
const THREAD_TRACK_TOLERANCE_PX = 20

type ScreenBox = { x: number; y: number; width: number; height: number }

function overlapArea(left: ScreenBox, right: ScreenBox): number {
  return Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)) *
    Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y))
}

async function addCardAndComment(page: any, request: any, comment: { type: string | null; text: string }): Promise<string> {
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
  return cardId
}

async function cardRecord(request: any, cardId: string): Promise<any> {
  const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
  return (snapshot.document?.store ?? snapshot.document?.records ?? {})[cardId]
}

async function addComment(request: any, cardId: string, comment: { type: string | null; text: string }) {
  const response = await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: { id: `comment-${Date.now()}-${Math.random()}`, author: 'claude', ops: [{ kind: 'add_comment', cardId, comment }] },
  })
  expect(response.ok()).toBe(true)
}

async function expectThreadWithinCanvas(page: any, thread: any) {
  const [threadBox, stageBox] = await Promise.all([
    thread.boundingBox(),
    page.locator('.tl-container').first().boundingBox(),
  ])
  expect(threadBox).not.toBeNull()
  expect(stageBox).not.toBeNull()
  expect(threadBox!.x).toBeGreaterThanOrEqual(stageBox!.x)
  expect(threadBox!.y).toBeGreaterThanOrEqual(stageBox!.y)
  expect(threadBox!.x + threadBox!.width).toBeLessThanOrEqual(stageBox!.x + stageBox!.width)
  expect(threadBox!.y + threadBox!.height).toBeLessThanOrEqual(stageBox!.y + stageBox!.height)
}

async function annotationGeometry(pin: any, thread: any): Promise<{ pin: ScreenBox; thread: ScreenBox }> {
  const [pinBox, threadBox] = await Promise.all([pin.boundingBox(), thread.boundingBox()])
  if (!pinBox || !threadBox) throw new Error('annotation pin or foreground thread is not rendered')
  return { pin: pinBox, thread: threadBox }
}

function expectThreadTracksPin(
  before: { pin: ScreenBox; thread: ScreenBox },
  after: { pin: ScreenBox; thread: ScreenBox },
) {
  const beforeOffset = { x: before.thread.x - before.pin.x, y: before.thread.y - before.pin.y }
  const afterOffset = { x: after.thread.x - after.pin.x, y: after.thread.y - after.pin.y }
  expect(Math.abs(afterOffset.x - beforeOffset.x)).toBeLessThanOrEqual(THREAD_TRACK_TOLERANCE_PX)
  expect(Math.abs(afterOffset.y - beforeOffset.y)).toBeLessThanOrEqual(THREAD_TRACK_TOLERANCE_PX)
}

async function replyComposer(thread: any) {
  const trigger = thread.getByRole('button', { name: 'Reply to annotation' })
  if (await trigger.isVisible().catch(() => false)) await trigger.click()
  return thread.getByRole('textbox', { name: 'Reply to annotation' })
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

test('promoted threads avoid their source and keep prior threads selectable', async ({ page, request }) => {
  await page.setViewportSize({ width: 1554, height: 942 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  for (let i = 0; i < 2; i++) {
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
  }
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const [firstCardId, secondCardId] = await serverCardIds(request, projectId)
  const [firstCard, secondCard] = await Promise.all([
    cardRecord(request, firstCardId),
    cardRecord(request, secondCardId),
  ])
  await moveCardsTool(BASE, projectId, {
    moves: [{ cardId: secondCardId, x: firstCard.x + 520, y: secondCard.y + 220 }],
  })
  await addComment(request, firstCardId, { type: 'needs-evidence', text: 'Needs evidence.' })
  await addComment(request, secondCardId, { type: 'weak-argument', text: 'Weak argument.' })

  const firstPin = page.locator(`[data-shape-id="${firstCardId}"] [data-testid="annotation-pin"]`)
  const secondPin = page.locator(`[data-shape-id="${secondCardId}"] [data-testid="annotation-pin"]`)
  const cardPositionsBefore = await Promise.all([
    page.locator(`[data-shape-id="${firstCardId}"]`).boundingBox(),
    page.locator(`[data-shape-id="${secondCardId}"]`).boundingBox(),
  ])
  await firstPin.click()
  await secondPin.click()
  const panels = page.getByTestId('annotation-popover')
  await expect(panels).toHaveCount(2)
  expect(await Promise.all([
    page.locator(`[data-shape-id="${firstCardId}"]`).boundingBox(),
    page.locator(`[data-shape-id="${secondCardId}"]`).boundingBox(),
  ])).toEqual(cardPositionsBefore)

  const activePanel = panels.filter({ hasText: 'Weak argument.' })
  const priorPanel = panels.filter({ hasText: 'Needs evidence.' })
  const source = page.locator(`[data-shape-id="${secondCardId}"]`)
  await expect.poll(async () => {
    const [panelBox, sourceBox] = await Promise.all([activePanel.boundingBox(), source.boundingBox()])
    return panelBox && sourceBox ? overlapArea(panelBox, sourceBox) : null
  }).toBe(0)
  const [activeBox, priorBox] = await Promise.all([activePanel.boundingBox(), priorPanel.boundingBox()])
  expect(activeBox).not.toBeNull()
  expect(priorBox).not.toBeNull()
  expect(Math.max(Math.abs(activeBox!.x - priorBox!.x), Math.abs(activeBox!.y - priorBox!.y)))
    .toBeGreaterThanOrEqual(32)

  await activePanel.getByLabel('Reply to annotation').click()
  await activePanel.locator('textarea').fill('Stable while the reply streams.')
  const activeSource = page.locator(`[data-shape-id="${secondCardId}"]`)
  const placementSide = async (panel: typeof activePanel, source: typeof activeSource) => {
    const [threadBox, sourceBox] = await Promise.all([panel.boundingBox(), source.boundingBox()])
    if (!threadBox || !sourceBox) return null
    if (threadBox.x >= sourceBox.x + sourceBox.width) return 'right'
    if (threadBox.x + threadBox.width <= sourceBox.x) return 'left'
    if (threadBox.y + threadBox.height <= sourceBox.y) return 'above'
    return 'below'
  }
  const sideBeforeReply = await placementSide(activePanel, activeSource)
  await activePanel.getByRole('button', { name: 'Send reply' }).click()
  await expect(activePanel).toContainText('Stub annotation reply: Stable while the reply streams.')
  expect(await placementSide(activePanel, activeSource)).toBe(sideBeforeReply)

  await firstPin.click()
  await expect(priorPanel.getByLabel('Reply to annotation')).toBeEnabled()
  await priorPanel.getByLabel('Reply to annotation').click()
  await priorPanel.locator('textarea').fill('Still reachable after promotion.')
  await page.mouse.click(24, 900)
  await expect(panels).toHaveCount(2)

  await page.getByLabel('Close annotation thread').first().click()
  await page.getByLabel('Close annotation thread').first().click()
  await page.setViewportSize({ width: 720, height: 640 })
  await page.reload()
  await createFeedbackTool(BASE, projectId, {
    text: 'Constrained edge.', x: 80, y: 300, type: 'weak-argument', reviewer: 'architect',
  })
  const { feedback } = await readMapTool(BASE, projectId)
  const constrainedFeedback = feedback.find((entry) => entry.text === 'Constrained edge.')!
  const constrainedPin = page.locator(`[data-annotation-target="feedback:${constrainedFeedback.id}"]`)
  await expect(constrainedPin).toBeVisible()
  await constrainedPin.click()
  const constrained = page.getByTestId('annotation-popover')
  await expect.poll(async () => {
    const [threadBox, stageBox] = await Promise.all([
      constrained.boundingBox(),
      page.locator('.tl-container').first().boundingBox(),
    ])
    return !!threadBox && !!stageBox && threadBox.x >= stageBox.x && threadBox.y >= stageBox.y &&
      threadBox.x + threadBox.width <= stageBox.x + stageBox.width &&
      threadBox.y + threadBox.height <= stageBox.y + stageBox.height
  }).toBe(true)
  await constrained.getByLabel('Reply to annotation').click()
  await expect(constrained.locator('textarea')).toBeVisible()
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

test('a fresh session has no open annotation threads', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Session-only thread.' })
  await page.getByTestId('annotation-pin').click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('annotation-thread')).toHaveCount(0)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(1)
})

test('an annotation draft survives close, reopen, and view changes until explicit discard', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'structure', text: 'Keep the response with this exact thread.' })
  const pin = page.getByTestId('annotation-pin')
  await pin.click()
  let thread = page.getByTestId('annotation-thread')
  await (await replyComposer(thread)).fill('A session-only draft')

  await thread.getByLabel('Close annotation thread').focus()
  await page.keyboard.press('Enter')
  await expect(pin).toBeFocused()
  await expect(page.getByTestId('annotation-popover')).toHaveClass(/--preview/)
  await pin.click()
  thread = page.getByTestId('annotation-thread')
  await expect(await replyComposer(thread)).toHaveValue('A session-only draft')

  await page.getByTestId('draft-open').click()
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')
  await expect(thread.getByRole('textbox', { name: 'Reply to annotation' })).toHaveValue('A session-only draft')
  await thread.getByRole('button', { name: 'Discard reply draft' }).click()
  await thread.getByRole('button', { name: 'Reply to annotation' }).click()
  await expect(thread.getByRole('textbox', { name: 'Reply to annotation' })).toHaveValue('')
})

test('hover and keyboard focus show a complete read-only preview', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, { type: 'structure', text: 'The complete conversation is readable here.' })
  const commentId = (await cardRecord(request, cardId)).props.comments[0].id
  const response = await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `preview-conversation-${Date.now()}`,
      author: 'claude',
      ops: [
        {
          kind: 'append_annotation_message',
          target: { kind: 'card', cardId, commentId },
          message: { id: 'preview-user', author: 'user', text: 'Which evidence should support this?', createdAt: '2026-08-30T09:00:00.000Z' },
        },
        {
          kind: 'append_annotation_message',
          target: { kind: 'card', cardId, commentId },
          message: { id: 'preview-claude', author: 'claude', text: 'Use the original source.', createdAt: '2026-08-30T09:01:00.000Z', inReplyToMessageId: 'preview-user' },
        },
      ],
    },
  })
  expect(response.ok()).toBe(true)

  const pin = page.getByTestId('annotation-pin')
  await pin.hover()
  const preview = page.getByTestId('annotation-popover')
  await expect(preview).toHaveClass(/elves-annotation-foreground-item--preview/)
  await expect(preview).toContainText('The complete conversation is readable here.')
  await expect(preview).toContainText('Which evidence should support this?')
  await expect(preview).toContainText('Use the original source.')
  await expect(preview.getByRole('button')).toHaveCount(0)
  await expect(preview.locator('textarea')).toHaveCount(0)
  expect(await preview.evaluate((element) => element.closest('.tl-shape'))).toBeNull()

  // Focus is its own entry route, not an artefact of the pointer hover. Leave
  // the pin, allow the short production hand-off timer to dismiss the preview,
  // then focus the button from outside the canvas annotation surface.
  await page.mouse.move(1, 1)
  await expect(preview).toHaveCount(0)
  await pin.focus()
  await expect(preview).toBeVisible()
})

test('clicking a pin replaces its preview with an interactive thread', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Open this conversation deliberately.' })

  const pin = page.getByTestId('annotation-pin')
  const popover = page.getByTestId('annotation-popover')
  await pin.hover()
  await expect(popover).toBeVisible()
  await expect(popover.getByRole('button')).toHaveCount(0)

  await pin.click()
  await expect(popover).toHaveClass(/elves-annotation-foreground-item--open/)
  const thread = popover.getByTestId('annotation-thread')
  await expect(thread.getByLabel('Reply to annotation')).toBeEnabled()
  await expect(thread.getByRole('button', { name: 'Send reply' })).toBeVisible()
  await expect(thread.getByRole('button', { name: /^Resolve .* comment$/ })).toBeVisible()
  await expect(thread.getByLabel('Close annotation thread')).toBeVisible()
})

test('foreground threads promote independently, persist resolution, and prune only a deleted anchor', async ({ page, request }) => {
  const proseCardId = await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Resolve this card comment.' })
  const proseCommentId = (await cardRecord(request, proseCardId)).props.comments[0].id

  await createNoteCardTool(BASE, projectId, { text: 'A removable annotation anchor.', x: 420, y: 180 })
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const removableCardId = (await serverCardIds(request, projectId)).find((id) => id !== proseCardId)!
  await addComment(request, removableCardId, { type: 'structure', text: 'Delete only this anchor.' })

  await createFeedbackTool(BASE, projectId, {
    text: 'Keep the floating annotation open.', x: 780, y: 260, type: 'weak-argument', reviewer: 'architect',
  })
  const { feedback } = await readMapTool(BASE, projectId)
  const feedbackId = feedback.find((item: any) => item.text === 'Keep the floating annotation open.')!.id

  const prosePin = page.locator(`[data-shape-id="${proseCardId}"] [data-testid="annotation-pin"]`)
  const removablePin = page.locator(`[data-shape-id="${removableCardId}"] [data-testid="annotation-pin"]`)
  const feedbackPin = page.locator(`[data-annotation-target="feedback:${feedbackId}"]`)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(3)

  await prosePin.click()
  await removablePin.click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(2)
  await prosePin.click() // promote the first target above the second target
  await page.getByLabel('Close annotation thread').first().click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(1)

  const remaining = page.getByTestId('annotation-thread')
  await expect(remaining).toContainText('Resolve this card comment.')
  await remaining.getByRole('button', { name: /^Resolve .* comment$/ }).click()
  await expect(prosePin).toHaveCount(0)
  await expect.poll(async () => {
    const comment = (await cardRecord(request, proseCardId)).props.comments.find((entry: any) => entry.id === proseCommentId)
    return comment?.resolved
  }).toBe(true)

  await removablePin.click()
  await feedbackPin.click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(2)
  await deleteCardTool(BASE, projectId, { cardId: removableCardId })
  await expect.poll(async () => page.getByTestId('annotation-thread').count()).toBe(1)
  await expect(page.locator(`[data-annotation-popover-target="feedback:${feedbackId}"]`)).toBeVisible()

  await expect(page.getByTestId('annotation-rail')).toHaveCount(0)
  await expect(page.locator('[data-feedback-stack]')).toHaveCount(0)
  await expect(page.locator('.elves-drawer-handle--split')).toHaveCount(0)
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'canvas')
})

test('attached comment pins remain compact at overview zoom', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'A comment that must become a marker.' })
  await page.getByRole('button', { name: /Zoom — 100%/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()

  await expect(page.getByTestId('annotation-pin')).toHaveCount(1)
  await expect(page.getByTestId('annotation-pin')).toHaveCSS('width', '28px')
})

test('an annotation reply streams then persists Claude’s answer', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, { type: 'needs-evidence', text: 'This claim needs a source.' })
  await addComment(request, cardId, { type: 'structure', text: 'This other thread stays editable.' })
  const [firstComment, secondComment] = (await cardRecord(request, cardId)).props.comments
  const firstPin = page.locator(`[data-annotation-target="card:${cardId}:${firstComment.id}"]`)
  const secondPin = page.locator(`[data-annotation-target="card:${cardId}:${secondComment.id}"]`)

  await firstPin.click()
  await secondPin.click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(2)
  await firstPin.click()
  const thread = page.locator(`[data-annotation-popover-target="card:${cardId}:${firstComment.id}"]`)
    .getByTestId('annotation-thread')
  const unaffectedThread = page.locator(`[data-annotation-popover-target="card:${cardId}:${secondComment.id}"]`)
    .getByTestId('annotation-thread')
  const reply = 'Which source should support this claim?'
  await (await replyComposer(thread)).fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.locator('.elves-annotation-thread__messages')).toBeFocused()

  await expect(thread).toContainText(reply)
  await expect(thread).toContainText('Stub is checking likely sources…')
  await expect(thread.getByRole('button', { name: 'Reply to annotation' })).toBeDisabled()
  await expect(unaffectedThread.getByRole('button', { name: 'Reply to annotation' })).toBeEnabled()
  await expect(thread).toContainText('Stub annotation reply: Which source should support this claim?')
  const nextReply = await replyComposer(thread)
  await expect(nextReply).toBeEnabled()
  await nextReply.fill('Please suggest the strongest source.')
  await expect(thread.getByRole('button', { name: 'Send reply' })).toBeEnabled()

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

test('a failed foreground reply retries its persisted user turn once', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Retry this foreground conversation.' })
  let releaseFailedRun!: () => void
  const failedRun = new Promise<void>((resolve) => { releaseFailedRun = resolve })
  let interceptedRuns = 0
  const routePattern = `**/projects/${projectId}/annotations/run`
  await page.route(routePattern, async (route) => {
    interceptedRuns += 1
    await failedRun
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'text', text: 'The interrupted interim answer.' })}\n\n`,
    })
  })

  await page.getByTestId('annotation-pin').click()
  const thread = page.getByTestId('annotation-thread')
  const reply = 'Retry without duplicating this message.'
  await (await replyComposer(thread)).fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread).toContainText('Claude is replying')
  await expect.poll(() => interceptedRuns).toBe(1)
  releaseFailedRun()
  await expect(thread.getByRole('alert')).toContainText('stream was interrupted')
  const retry = thread.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()

  await page.unroute(routePattern)
  await retry.click()
  await expect(thread).toContainText('Claude is replying')

  const [cardId] = await serverCardIds(request, projectId)
  await expect.poll(async () => {
    const card = await cardRecord(request, cardId)
    const messages = card.props.comments[0].messages ?? []
    const users = messages.filter((message: any) => message.author === 'user' && message.text === reply)
    const answers = messages.filter((message: any) =>
      message.author === 'claude' && message.inReplyToMessageId === users[0]?.id)
    return { users: users.length, answers: answers.length, linked: answers[0]?.inReplyToMessageId === users[0]?.id }
  }).toEqual({ users: 1, answers: 1, linked: true })
})

test('a response-lost reply resend reuses its persisted user turn', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, {
    type: 'needs-evidence', text: 'Keep exactly one durable user turn.',
  })
  const commentId = (await cardRecord(request, cardId)).props.comments[0].id
  const pin = page.locator(`[data-shape-id="${cardId}"] [data-testid="annotation-pin"]`)
  await pin.click()
  const thread = page.getByTestId('annotation-thread')
  const reply = 'Retry this exact durable reply.'
  let persistenceAttempts = 0
  await page.route(`**/projects/${projectId}/changeset`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    persistenceAttempts += 1
    const response = await route.fetch()
    if (persistenceAttempts === 1) {
      await route.fulfill({ status: 503, body: 'response lost after commit' })
      return
    }
    await route.fulfill({ response })
  })

  await (await replyComposer(thread)).fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.getByRole('alert')).toBeVisible()
  await (await replyComposer(thread)).fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect.poll(() => persistenceAttempts).toBe(2)

  await expect.poll(async () => {
    const card = await cardRecord(request, cardId)
    return card.props.comments.find((comment: any) => comment.id === commentId)!.messages
      .filter((message: any) => message.author === 'user' && message.text === reply).length
  }).toBe(1)
})

test('a changed resend clears the retained failed identity before an old draft is sent again', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, {
    type: 'needs-evidence', text: 'Do not retain an old retry identity after a new reply persists.',
  })
  const commentId = (await cardRecord(request, cardId)).props.comments[0].id
  await page.locator(`[data-shape-id="${cardId}"] [data-testid="annotation-pin"]`).click()
  const thread = page.getByTestId('annotation-thread')
  const originalReply = 'This was the response-lost reply.'
  const revisedReply = 'This is the edited reply that succeeds.'
  let persistenceAttempts = 0
  await page.route(`**/projects/${projectId}/changeset`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    persistenceAttempts += 1
    const response = await route.fetch()
    if (persistenceAttempts === 1) {
      await route.fulfill({ status: 503, body: 'response lost after commit' })
      return
    }
    await route.fulfill({ response })
  })

  await (await replyComposer(thread)).fill(originalReply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.getByRole('alert')).toBeVisible()
  await (await replyComposer(thread)).fill(revisedReply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.getByRole('button', { name: 'Reply to annotation' })).toBeEnabled()
  await (await replyComposer(thread)).fill(originalReply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect.poll(() => persistenceAttempts).toBe(3)

  await expect.poll(async () => {
    const card = await cardRecord(request, cardId)
    const originalMessages = card.props.comments.find((comment: any) => comment.id === commentId)!.messages
      .filter((message: any) => message.author === 'user' && message.text === originalReply)
    return { count: originalMessages.length, ids: new Set(originalMessages.map((message: any) => message.id)).size }
  }).toEqual({ count: 2, ids: 2 })
})

test('a long annotation transcript remains inside the canvas and scrolls internally', async ({ page, request }) => {
  await page.setViewportSize({ width: 800, height: 420 })
  const cardId = await addCardAndComment(page, request, { type: 'structure', text: 'Keep this full annotation inside the stage.' })
  const commentId = (await cardRecord(request, cardId)).props.comments[0].id
  const response = await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `long-annotation-${Date.now()}`,
      author: 'claude',
      ops: Array.from({ length: 28 }, (_, index) => ({
        kind: 'append_annotation_message',
        target: { kind: 'card', cardId, commentId },
        message: {
          id: `long-annotation-message-${index}`,
          author: index % 2 ? 'user' : 'claude',
          text: `Long annotation message ${index}: this deliberately wraps across multiple lines so the transcript must scroll within the bounded foreground panel.`,
          createdAt: `2026-08-30T10:${String(index).padStart(2, '0')}:00.000Z`,
        },
      })),
    },
  })
  expect(response.ok()).toBe(true)

  await page.getByTestId('annotation-pin').click()
  const thread = page.getByTestId('annotation-thread')
  const transcript = thread.locator('.elves-annotation-thread__messages')
  await expectThreadWithinCanvas(page, thread)
  expect(await transcript.evaluate((element) => ({
    overflowY: getComputedStyle(element).overflowY,
    scrollable: element.scrollHeight > element.clientHeight,
  }))).toEqual({ overflowY: 'auto', scrollable: true })
  await transcript.locator('.elves-annotation-thread__message').last().scrollIntoViewIfNeeded()
  expect(await transcript.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

test('a foreground thread follows its pin through pan, zoom, and card movement', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, { type: 'structure', text: 'Keep this thread aligned with its card.' })
  const pin = page.locator(`[data-shape-id="${cardId}"] [data-testid="annotation-pin"]`)
  await pin.click()
  const thread = page.getByTestId('annotation-thread')
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  expect(viewport.width).toBeGreaterThan(0)
  await expectThreadWithinCanvas(page, thread)

  const stage = page.locator('.tl-container').first()
  const stageBox = await stage.boundingBox()
  expect(stageBox).not.toBeNull()
  const beforePan = await annotationGeometry(pin, thread)
  await page.mouse.move(stageBox!.x + stageBox!.width * 0.2, stageBox!.y + stageBox!.height * 0.2)
  await page.mouse.wheel(-90, -60)
  await expect.poll(async () => (await pin.boundingBox())?.x ?? null).not.toBe(beforePan.pin.x)
  await expect.poll(async () => (await thread.boundingBox())?.x ?? null).not.toBe(beforePan.thread.x)
  const afterPan = await annotationGeometry(pin, thread)
  expectThreadTracksPin(beforePan, afterPan)
  await expectThreadWithinCanvas(page, thread)

  const beforeZoom = await annotationGeometry(pin, thread)
  await page.getByRole('button', { name: /Zoom —/ }).click()
  await page.getByRole('menuitem', { name: /Zoom out/ }).click()
  await expect.poll(async () => {
    const next = await annotationGeometry(pin, thread)
    return Math.hypot(next.pin.x - beforeZoom.pin.x, next.pin.y - beforeZoom.pin.y)
  }).toBeGreaterThan(0.5)
  const afterZoom = await annotationGeometry(pin, thread)
  expectThreadTracksPin(beforeZoom, afterZoom)
  await expectThreadWithinCanvas(page, thread)

  const beforeMove = await annotationGeometry(pin, thread)
  const card = await cardRecord(request, cardId)
  const stageCenter = {
    x: stageBox!.x + stageBox!.width / 2,
    y: stageBox!.y + stageBox!.height / 2,
  }
  const move = {
    x: beforeMove.pin.x > stageCenter.x ? -80 : 80,
    y: beforeMove.pin.y > stageCenter.y ? -60 : 60,
  }
  await moveCardsTool(BASE, projectId, { moves: [{ cardId, x: card.x + move.x, y: card.y + move.y }] })
  await expect.poll(async () => (await pin.boundingBox())?.x ?? null).not.toBe(beforeMove.pin.x)
  await expect.poll(async () => (await thread.boundingBox())?.x ?? null).not.toBe(beforeMove.thread.x)
  const afterMove = await annotationGeometry(pin, thread)
  expect(Math.abs(afterMove.pin.x - beforeMove.pin.x)).toBeGreaterThan(20)
  expect(Math.abs(afterMove.thread.x - beforeMove.thread.x)).toBeGreaterThan(20)
  expectThreadTracksPin(beforeMove, afterMove)
  await expectThreadWithinCanvas(page, thread)
})
