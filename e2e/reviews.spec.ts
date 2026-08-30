import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'
import { createFeedbackTool, createReferenceTool, readMapTool } from '../mcp/tools'

let projectId: string
const STAGE_EDGE_TOLERANCE_PX = 96

type ScreenBox = { x: number; y: number; width: number; height: number }

// reviews.json is project metadata, so resetProject's canvas clear doesn't touch
// it. Dismiss whatever earlier tests left behind — dismissed passes are hidden
// from the panel, which is all these assertions need.
async function resetReviews(request: APIRequestContext): Promise<void> {
  const { reviews } = await (await request.get(`${BASE}/projects/${projectId}/reviews`)).json()
  for (const r of reviews) {
    if (r.status === 'dismissed') continue
    await request.post(`${BASE}/projects/${projectId}/reviews/${r.id}/status`, {
      data: { status: 'dismissed' },
    })
  }
}

async function openCanvas(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-prose')).toBeEnabled()
}

function expectBoxWithinStage(box: ScreenBox, stage: ScreenBox) {
  expect(box.x).toBeGreaterThanOrEqual(stage.x)
  expect(box.y).toBeGreaterThanOrEqual(stage.y)
  expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
  expect(box.y + box.height).toBeLessThanOrEqual(stage.y + stage.height)
}

function expectAtStageEdge(
  pin: ScreenBox,
  thread: ScreenBox,
  stage: ScreenBox,
  horizontal: 'left' | 'right',
  vertical: 'top' | 'bottom',
) {
  const horizontalInset = horizontal === 'left'
    ? pin.x - stage.x
    : stage.x + stage.width - (pin.x + pin.width)
  const verticalInset = vertical === 'top'
    ? pin.y - stage.y
    : stage.y + stage.height - (pin.y + pin.height)
  const threadHorizontalInset = horizontal === 'left'
    ? thread.x - stage.x
    : stage.x + stage.width - (thread.x + thread.width)
  const threadVerticalInset = vertical === 'top'
    ? thread.y - stage.y
    : stage.y + stage.height - (thread.y + thread.height)

  expect(horizontalInset).toBeLessThanOrEqual(STAGE_EDGE_TOLERANCE_PX)
  expect(verticalInset).toBeLessThanOrEqual(STAGE_EDGE_TOLERANCE_PX)
  expect(threadHorizontalInset).toBeLessThanOrEqual(STAGE_EDGE_TOLERANCE_PX)
  expect(threadVerticalInset).toBeLessThanOrEqual(STAGE_EDGE_TOLERANCE_PX)
}

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
  await resetReviews(request)
})

// Summoning now spawns a headless agent SERVER-SIDE (server/app.ts's
// launchReviewRun) rather than leaving the pass `pending` for an external agent
// to pick up. That agent can't be stubbed via browser-level page.route (it's
// not the browser making the request) — playwright.config.ts instead points
// the server's ELVES_CLI_BIN at e2e/fixtures/stub-agent.mjs, a deterministic
// stand-in that plays the review over the same HTTP surface the elves MCP uses.
// These tests exercise the real spawn → claim → comment → verdict pipeline, so
// they use generous polls rather than instant assertions.
test('duplicate reviewer passes have contextual clear controls', async ({ page, request }) => {
  await openCanvas(page)

  await page.getByTestId('review-button').click()
  await page.getByTestId('review-focus').fill('just the opening')
  await page.getByTestId('review-summon-devils-advocate').click()
  const passes = page.getByTestId('review-pass-devils-advocate')
  await expect.poll(async () => passes.first().getAttribute('data-status'), {
    timeout: 20000,
  }).toBe('done')

  await page.getByTestId('review-focus').fill('just the ending')
  await page.getByTestId('review-summon-devils-advocate').click()

  // Both passes show up as done, each with a distinct action in the page-wide
  // control list a screen reader exposes.
  await expect(passes).toHaveCount(2)
  await expect.poll(async () => passes.evaluateAll(
    (rows) => rows.map((row) => row.getAttribute('data-status')),
  ), { timeout: 20000 }).toEqual(['done', 'done'])
  const clearOpening = page.getByRole('button', {
    name: /^Clear Devil's Advocate review from panel: just the opening; requested .+; pass \d of 2$/,
  })
  const clearEnding = page.getByRole('button', {
    name: /^Clear Devil's Advocate review from panel: just the ending; requested .+; pass \d of 2$/,
  })
  await expect(clearOpening).toHaveCount(1)
  await expect(clearEnding).toHaveCount(1)

  // And on the server, where the pass history remains distinct.
  const { reviews } = await (await request.get(`${BASE}/projects/${projectId}/reviews`)).json()
  const done = reviews.filter((r: any) => r.status === 'done')
  expect(done).toHaveLength(2)
  expect(done.every((r: any) => r.personality === 'devils-advocate')).toBe(true)
  expect(done.map((r: any) => r.focus).sort()).toEqual(['just the ending', 'just the opening'])

  await clearOpening.click()
  await expect(clearOpening).toHaveCount(0)
  await expect(page.getByRole('button', {
    name: /^Clear Devil's Advocate review from panel: just the ending; requested .+; pass 1 of 1$/,
  })).toHaveCount(1)
})

test('same-personality passes without focus use distinct requested times', async ({ page }) => {
  await openCanvas(page)
  await page.getByTestId('review-button').click()
  await page.getByTestId('review-summon-trimmer').click()
  const passes = page.getByTestId('review-pass-trimmer')
  await expect.poll(async () => passes.first().getAttribute('data-status'), {
    timeout: 20000,
  }).toBe('done')
  await page.waitForTimeout(5)
  await page.getByTestId('review-summon-trimmer').click()
  await expect(passes).toHaveCount(2)
  await expect.poll(async () => passes.evaluateAll(
    (rows) => rows.map((row) => row.getAttribute('data-status')),
  ), { timeout: 20000 }).toEqual(['done', 'done'])

  const clearButtons = page.getByRole('button', {
    name: /^Clear The Trimmer review from panel: requested /,
  })
  await expect(clearButtons).toHaveCount(2)
  const labels = await clearButtons.evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label')),
  )
  expect(new Set(labels).size).toBe(2)
})

test('summoning runs a full pass in-app', async ({ page, request }) => {
  await openCanvas(page)
  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  // Finish the newly-created card's edit session before the stub agent writes.
  // Current clients deliberately defer remote snapshot loads while the user is
  // typing so an agent update cannot discard unsaved keystrokes.
  await page.keyboard.press('Escape')

  await page.getByTestId('review-button').click()
  await page.getByTestId('review-summon-trimmer').click()

  const pass = page.getByTestId('review-pass-trimmer')
  await expect(pass).toBeVisible()

  // The stub claims almost immediately, but it's a real child process — give it
  // room. It advances pending -> in-progress -> done on its own; the stub is
  // fast enough that polling can catch it already past in-progress, so assert
  // the intermediate state loosely (it left pending via in-progress, not by
  // jumping straight to some other state) before waiting for done.
  await expect.poll(
    async () => (await pass.getAttribute('data-status')),
    { timeout: 20000 },
  ).not.toBe('pending')
  expect(['in-progress', 'done']).toContain(await pass.getAttribute('data-status'))
  await expect.poll(
    async () => (await pass.getAttribute('data-status')),
    { timeout: 20000 },
  ).toBe('done')

  await expect(page.getByTestId('review-verdict')).toContainText('Stub verdict')
  await expect(page.getByTestId('review-tally-trimmer')).toContainText('1 open · 1 notes')

  // The tagged comment renders as the shared compact marker, retaining its
  // review type while its conversation opens in the foreground canvas layer.
  const pin = page.locator('[data-testid="annotation-pin"][data-type="tighten"]')
  await expect(pin).toBeVisible()
  await expect(pin).toHaveAccessibleName(/stub note/)

  await expect(
    page.getByRole('button', {
      name: /^Clear The Trimmer review from panel: requested /,
    }),
  ).toBeVisible()

  // The old "wait for an external agent" hint is gone entirely — the app runs
  // the pass itself now.
  await expect(page.getByTestId('review-hint')).toHaveCount(0)
})

test('floating feedback opens in the foreground and resolving leaves a durable record', async ({ page }) => {
  await openCanvas(page)
  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')

  await createFeedbackTool(BASE, projectId, {
    text: 'The middle needs a bridge',
    x: 80,
    y: 80,
    type: 'structure',
    reviewer: 'architect',
  })

  const marker = page.getByTestId('annotation-pin')
  await expect(marker).toBeVisible()
  await expect(page.locator('.elves-feedback')).toHaveCount(0)
  await marker.click()
  const thread = page.getByTestId('annotation-thread')
  await expect(thread).toBeVisible()
  await expect(thread).toContainText('The middle needs a bridge')
  await expect(thread.getByLabel('Reply to annotation')).toBeEnabled()
  await thread.getByRole('button', { name: /^Resolve .* comment$/ }).click()
  await expect(marker).toHaveCount(0)

  await expect.poll(async () => {
    const { feedback } = await readMapTool(BASE, projectId)
    return feedback[0]?.resolved
  }).toBe(true)
  await expect(page.getByTestId('annotation-rail')).toHaveCount(0)
  await expect(page.locator('[data-feedback-stack]')).toHaveCount(0)
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'canvas')
})

test('foreground threads stay operable at every canvas edge above cards, feedback, and link previews', async ({ page, request }) => {
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 }
  await page.setViewportSize(viewport)
  await openCanvas(page)
  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [proseCardId] = await serverCardIds(request, projectId)

  // The server's own JSON endpoint produces a local, deterministic fallback
  // reference card, avoiding a real-network dependency while retaining the
  // actual link-preview rendering path.
  await createReferenceTool(BASE, projectId, {
    url: `${BASE}/projects`, x: 560, y: 260,
    fields: { title: 'Foreground reference', refType: 'article', siteName: 'elves.test' },
  })
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)
  const referenceCardId = (await serverCardIds(request, projectId)).find((id) => id !== proseCardId)!
  const commentResponse = await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `foreground-surface-comments-${Date.now()}`,
      author: 'claude',
      ops: [
        { kind: 'add_comment', cardId: proseCardId, comment: { type: 'structure', text: 'Foreground above the prose card.' } },
        { kind: 'add_comment', cardId: referenceCardId, comment: { type: 'needs-citation', text: 'Foreground above the link preview.' } },
      ],
    },
  })
  expect(commentResponse.ok()).toBe(true)

  const edgeFeedback = [
    { text: 'Top-left feedback.', x: 8, y: 8, horizontal: 'left' as const, vertical: 'top' as const },
    { text: 'Top-right feedback.', x: viewport.width - 64, y: 8, horizontal: 'right' as const, vertical: 'top' as const },
    { text: 'Bottom-left feedback.', x: 8, y: viewport.height - 64, horizontal: 'left' as const, vertical: 'bottom' as const },
    { text: 'Bottom-right feedback.', x: viewport.width - 64, y: viewport.height - 64, horizontal: 'right' as const, vertical: 'bottom' as const },
  ]
  for (const item of edgeFeedback) {
    await createFeedbackTool(BASE, projectId, { ...item, type: 'weak-argument', reviewer: 'architect' })
  }

  const prosePin = page.locator(`[data-shape-id="${proseCardId}"] [data-testid="annotation-pin"]`)
  const referencePin = page.locator(`[data-shape-id="${referenceCardId}"] [data-testid="annotation-pin"]`)
  await expect(page.getByTestId('annotation-pin')).toHaveCount(6)
  const { feedback } = await readMapTool(BASE, projectId)
  const edgePins = edgeFeedback.map((item) => ({
    ...item,
    pin: page.locator(`[data-annotation-target="feedback:${feedback.find((entry) => entry.text === item.text)!.id}"]`),
  }))
  const pins = [
    { pin: prosePin },
    { pin: referencePin },
    ...edgePins,
  ]
  const stage = page.locator('.tl-container').first()
  const stageBox = await stage.boundingBox()
  expect(stageBox).not.toBeNull()

  for (const { pin, ...edge } of pins) {
    await expect(pin).toBeVisible()
    await pin.click()
    const popover = page.getByTestId('annotation-popover')
    const thread = popover.getByTestId('annotation-thread')
    await expect(thread).toBeVisible()
    const [pinBox, threadBox, textareaBox, sendBox, resolveBox, closeBox] = await Promise.all([
      pin.boundingBox(),
      thread.boundingBox(),
      thread.getByLabel('Reply to annotation').boundingBox(),
      thread.getByRole('button', { name: 'Send reply' }).boundingBox(),
      thread.getByRole('button', { name: /^Resolve .* comment$/ }).boundingBox(),
      thread.getByLabel('Close annotation thread').boundingBox(),
    ])
    expect(pinBox).not.toBeNull()
    expect(threadBox).not.toBeNull()
    expectBoxWithinStage(pinBox!, stageBox!)
    expectBoxWithinStage(threadBox!, stageBox!)
    if (edge.horizontal && edge.vertical) {
      expectAtStageEdge(pinBox!, threadBox!, stageBox!, edge.horizontal, edge.vertical)
    }
    for (const control of [textareaBox, sendBox, resolveBox, closeBox]) {
      expect(control).not.toBeNull()
      const foregroundTarget = await page.evaluate(({ x, y }) => Boolean(
        document.elementFromPoint(x, y)?.closest('[data-testid="annotation-thread"]'),
      ), { x: control!.x + control!.width / 2, y: control!.y + control!.height / 2 })
      expect(foregroundTarget).toBe(true)
    }
    await thread.getByLabel('Reply to annotation').fill('A reachable foreground draft.')
    await expect(thread.getByRole('button', { name: 'Send reply' })).toBeEnabled()
    await thread.getByLabel('Close annotation thread').click()
    await expect(thread).toHaveCount(0)
  }

  // The bottom-right panel must keep the same foreground affordances after a
  // stream error: Retry is visible, receives the actual pointer click, and
  // starts the saved user turn again.
  const failedEdge = edgePins[3]
  let releaseFailedRun!: () => void
  const failedRun = new Promise<void>((resolve) => { releaseFailedRun = resolve })
  let interceptedRuns = 0
  const routePattern = `**/projects/${projectId}/annotations/run`
  await page.route(routePattern, async (route) => {
    interceptedRuns += 1
    await failedRun
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: {"type":"text","text":"Interim edge reply."}\n\n' })
  })
  await failedEdge.pin.click()
  const failedThread = page.getByTestId('annotation-thread')
  await expect(failedThread).toBeVisible()
  const [failedPinBox, failedThreadBox] = await Promise.all([failedEdge.pin.boundingBox(), failedThread.boundingBox()])
  expect(failedPinBox).not.toBeNull()
  expect(failedThreadBox).not.toBeNull()
  expectBoxWithinStage(failedPinBox!, stageBox!)
  expectBoxWithinStage(failedThreadBox!, stageBox!)
  expectAtStageEdge(failedPinBox!, failedThreadBox!, stageBox!, failedEdge.horizontal, failedEdge.vertical)
  await failedThread.getByLabel('Reply to annotation').fill('Retry from the bottom-right edge.')
  await failedThread.getByRole('button', { name: 'Send reply' }).click()
  await expect(failedThread.getByRole('button', { name: 'Replying…' })).toBeDisabled()
  await expect.poll(() => interceptedRuns).toBe(1)
  releaseFailedRun()
  await expect(failedThread.getByRole('alert')).toContainText('stream was interrupted')
  const retry = failedThread.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  const retryBox = await retry.boundingBox()
  expect(retryBox).not.toBeNull()
  expect(await page.evaluate(({ x, y }) => Boolean(
    document.elementFromPoint(x, y)?.closest('[data-testid="annotation-thread"]'),
  ), { x: retryBox!.x + retryBox!.width / 2, y: retryBox!.y + retryBox!.height / 2 })).toBe(true)
  await page.unroute(routePattern)
  await retry.click()
  await expect(failedThread.getByRole('button', { name: 'Replying…' })).toBeDisabled()
  await expect(failedThread).toContainText('Stub annotation reply: Retry from the bottom-right edge.')
  await failedThread.getByLabel('Close annotation thread').click()

  // Promotion puts the repeated target at the top of the foreground stack.
  // These are real simultaneous foreground panels, rather than per-shape z-indexes.
  const proseTarget = await prosePin.getAttribute('data-annotation-target')
  const referenceTarget = await referencePin.getAttribute('data-annotation-target')
  await prosePin.click()
  await referencePin.click()
  const simultaneous = page.getByTestId('annotation-popover')
  await expect(simultaneous).toHaveCount(2)
  expect(await simultaneous.evaluateAll((items) => items.map((item) => item.style.zIndex))).toEqual(['1', '2'])
  await prosePin.click()
  await expect(simultaneous).toHaveCount(2)
  expect(await simultaneous.evaluateAll((items) => items.map((item) => item.getAttribute('data-annotation-popover-target'))))
    .toEqual([referenceTarget, proseTarget])
  expect(await simultaneous.evaluateAll((items) => items.map((item) => item.style.zIndex))).toEqual(['1', '2'])

  // The layer itself is pointer-transparent, so clear canvas space can still
  // start a normal tldraw pan rather than catching the interaction in an overlay.
  const beforePan = await prosePin.boundingBox()
  await page.mouse.move(stageBox!.x + 40, stageBox!.y + stageBox!.height - 40)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(stageBox!.x + 100, stageBox!.y + stageBox!.height - 10)
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect.poll(async () => (await prosePin.boundingBox())?.x ?? null).not.toBe(beforePan?.x ?? null)
  await page.getByLabel('Close annotation thread').first().click()
  await page.getByLabel('Close annotation thread').first().click()
})

test('a failing run marks the pass failed, with Retry', async ({ page }) => {
  await openCanvas(page)

  // focus '__fail__' tells the stub to exit(1) without claiming — the server's
  // launchReviewRun completion handler then marks the pass failed itself.
  await page.getByTestId('review-button').click()
  await page.getByTestId('review-focus').fill('__fail__')
  await page.getByTestId('review-summon-devils-advocate').click()

  const pass = page.getByTestId('review-pass-devils-advocate')
  await expect(pass).toBeVisible()
  await expect.poll(
    async () => (await pass.getAttribute('data-status')),
    { timeout: 20000 },
  ).toBe('failed')

  await expect(page.getByTestId('review-error')).toBeVisible()
  const clearFailed = page.getByRole('button', {
    name: /^Clear failed Devil's Advocate review from panel: __fail__; requested .+; pass 1 of 1$/,
  })
  await expect(clearFailed).toBeVisible()
  await expect(clearFailed).toHaveAttribute('title', 'Clear from panel')
  const retry = page.getByTestId('review-retry-devils-advocate')
  await expect(retry).toBeVisible()

  // Retry re-spawns the stub, which fails again (focus is still __fail__) — the
  // pass should cycle back through in-progress and land failed once more, with
  // Retry still offered.
  await retry.click()
  await expect.poll(
    async () => (await pass.getAttribute('data-status')),
    { timeout: 20000 },
  ).toBe('failed')
  await expect(retry).toBeVisible()

  await expect(page.getByTestId('review-hint')).toHaveCount(0)
})

test('dismissing a running/failed pass clears it', async ({ page }) => {
  await openCanvas(page)

  await page.getByTestId('review-button').click()
  await page.getByTestId('review-summon-first-reader').click()

  const pass = page.getByTestId('review-pass-first-reader')
  await expect(pass).toBeVisible()

  await page.getByTestId('review-dismiss-first-reader').click()
  await expect(pass).toHaveCount(0)
})
