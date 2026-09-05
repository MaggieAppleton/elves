import { test, expect } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'
import { createFeedbackTool, createNoteCardTool, deleteCardTool, moveCardsTool, readMapTool } from '../mcp/tools'

let projectId: string
const THREAD_TRACK_TOLERANCE_PX = 8

type ScreenBox = { x: number; y: number; width: number; height: number }

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

test('a fresh session has no open annotation threads', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Session-only thread.' })
  await page.getByTestId('annotation-pin').click()
  await expect(page.getByTestId('annotation-thread')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('annotation-thread')).toHaveCount(0)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(1)
})

test('hover and keyboard focus show a compact read-only preview', async ({ page, request }) => {
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
  await expect(preview).not.toContainText('Which evidence should support this?')
  await expect(preview).not.toContainText('Use the original source.')
  await expect(preview.locator('.elves-annotation-thread__reply-count')).toHaveAttribute('aria-label', '2 replies')
  await expect(preview.locator('.elves-annotation-thread__messages')).toHaveCount(0)
  await expect(preview.getByTestId('annotation-thread')).toHaveAttribute(
    'aria-label',
    /Annotation preview: Structure from Claude: The complete conversation is readable here\. 2 replies/,
  )
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
  await expect(preview).not.toHaveAttribute('data-motion')
})

test('clicking a pointer preview expands it in place into the complete thread once', async ({ page, request }) => {
  const cardId = await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Open this conversation deliberately.' })
  const commentId = (await cardRecord(request, cardId)).props.comments[0].id
  await request.post(`${BASE}/projects/${projectId}/changeset`, { data: {
    id: `preview-open-${Date.now()}`, author: 'user', ops: [{
      kind: 'append_annotation_message', target: { kind: 'card', cardId, commentId },
      message: { id: 'preview-open-user', author: 'user', text: 'Show this after opening.', createdAt: '2026-09-05T09:00:00Z' },
    }],
  } })

  const pin = page.getByTestId('annotation-pin')
  const popover = page.getByTestId('annotation-popover')
  await pin.hover()
  await expect(popover).toBeVisible()
  await expect(popover).toHaveAttribute('data-motion', 'enter')
  const placementSide = await popover.getAttribute('data-placement-side')
  await expect(popover.getByRole('button')).toHaveCount(0)
  const before = await popover.boundingBox()
  const animationStart = await popover.evaluate((element) => element.getAnimations()[0]?.startTime)

  await popover.click()
  await expect(popover).toHaveClass(/elves-annotation-foreground-item--open/)
  await expect(popover).toHaveAttribute('data-motion', 'enter')
  await expect(popover).toHaveAttribute('data-placement-side', placementSide!)
  expect(await popover.evaluate((element) => element.getAnimations()[0]?.startTime)).toBe(animationStart)
  const after = await popover.boundingBox()
  expect(Math.hypot((after?.x ?? 0) - (before?.x ?? 0), (after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(32)
  const thread = popover.getByTestId('annotation-thread')
  await expect(thread).toContainText('Open this conversation deliberately.')
  await expect(thread).toContainText('Show this after opening.')
  await expect(thread.getByLabel('Reply to annotation')).toBeEnabled()
  await thread.getByLabel('Reply to annotation').click()
  await expect(thread.getByRole('button', { name: 'Send reply' })).toBeVisible()
  await expect(thread.getByRole('button', { name: /^Resolve .* comment$/ })).toBeVisible()
  await expect(thread.getByLabel('Close annotation thread')).toBeVisible()
})

test('pointer close is briefly inert while keyboard and reduced-motion close are immediate', async ({ page, request }) => {
  await addCardAndComment(page, request, { type: 'needs-evidence', text: 'Close this thread deliberately.' })
  const pin = page.getByTestId('annotation-pin')
  await pin.click()
  let popover = page.getByTestId('annotation-popover')
  const closingState = await popover.getByLabel('Close annotation thread').evaluate(async (button: HTMLButtonElement) => {
    const target = button.closest<HTMLElement>('[data-testid="annotation-popover"]')?.dataset.annotationPopoverTarget
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await new Promise(requestAnimationFrame)
    const panel = document.querySelector<HTMLElement>(`[data-annotation-popover-target="${target}"]`)
    return { motion: panel?.dataset.motion, pointerEvents: panel && getComputedStyle(panel).pointerEvents }
  })
  expect(closingState).toEqual({ motion: 'exit', pointerEvents: 'none' })
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-target')))
    .toBe(await pin.getAttribute('data-annotation-target'))
  await expect(popover).toHaveCount(0)

  await pin.focus()
  await page.keyboard.press('Enter')
  popover = page.getByTestId('annotation-popover')
  await expect(popover).toHaveClass(/--open/)
  await popover.getByLabel('Close annotation thread').focus()
  await page.keyboard.press('Enter')
  await expect(popover).toHaveClass(/--preview/)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await pin.click()
  popover = page.getByTestId('annotation-popover')
  await expect(popover).toHaveCSS('animation-name', 'none')
  await popover.getByLabel('Close annotation thread').click()
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-annotation-target')))
    .toBe(await pin.getAttribute('data-annotation-target'))
  await expect(popover).toHaveCount(0)
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
  const thread = page.locator(`[data-annotation-popover-target="card:${cardId}:${firstComment.id}"]`)
    .getByTestId('annotation-thread')
  const unaffectedThread = page.locator(`[data-annotation-popover-target="card:${cardId}:${secondComment.id}"]`)
    .getByTestId('annotation-thread')
  const reply = 'Which source should support this claim?'
  await thread.getByLabel('Reply to annotation').fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()

  await expect(thread).toContainText(reply)
  await expect(thread).toContainText('Stub is checking likely sources…')
  await expect(thread.getByRole('button', { name: 'Replying…' })).toBeDisabled()
  await expect(unaffectedThread.getByLabel('Reply to annotation')).toBeEnabled()
  await expect(thread).toContainText('Stub annotation reply: Which source should support this claim?')
  const nextReply = thread.getByLabel('Reply to annotation')
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
  await thread.getByLabel('Reply to annotation').fill(reply)
  await thread.getByRole('button', { name: 'Send reply' }).click()
  await expect(thread.getByRole('button', { name: 'Replying…' })).toBeDisabled()
  await expect.poll(() => interceptedRuns).toBe(1)
  releaseFailedRun()
  await expect(thread.getByRole('alert')).toContainText('stream was interrupted')
  const retry = thread.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()

  await page.unroute(routePattern)
  await retry.click()
  await expect(thread.getByRole('button', { name: 'Replying…' })).toBeDisabled()

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
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(stageBox!.x + stageBox!.width * 0.2 + 90, stageBox!.y + stageBox!.height * 0.2 + 60)
  await page.mouse.up()
  await page.keyboard.up('Space')
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
  await moveCardsTool(BASE, projectId, { moves: [{ cardId, x: card.x + 160, y: card.y + 110 }] })
  await expect.poll(async () => (await pin.boundingBox())?.x ?? null).not.toBe(beforeMove.pin.x)
  await expect.poll(async () => (await thread.boundingBox())?.x ?? null).not.toBe(beforeMove.thread.x)
  const afterMove = await annotationGeometry(pin, thread)
  expect(afterMove.pin.x).toBeGreaterThan(beforeMove.pin.x + 40)
  expect(afterMove.thread.x).toBeGreaterThan(beforeMove.thread.x + 40)
  expectThreadTracksPin(beforeMove, afterMove)
  await expectThreadWithinCanvas(page, thread)
})
