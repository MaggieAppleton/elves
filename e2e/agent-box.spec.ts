import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

// A canned SSE body — the exact frames the server would stream — so these tests
// exercise the real box (hotkey, streaming render, cancel) without spawning a
// real CLI. The client reads the whole body, splits frames on the blank line,
// and dispatches each event, so a single fulfilled response is enough.
const sse = (frames: string[]) => frames.map((f) => `${f}\n\n`).join('') + 'event: end\ndata: {}\n\n'
const dataFrame = (e: unknown) => `data: ${JSON.stringify(e)}`

async function installAgentStream(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const originalFetch = fetch.bind(globalThis)
    const encoder = new TextEncoder()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let cancelStatus = 200
    let releaseRunResponse: (() => void) | undefined
    let runResponseGate: Promise<void> | undefined
    const cancelBodies: Array<{ runId: string }> = []
    ;(window as any).__agentTest = {
      push: (event: unknown) => controller?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
      end: () => {
        controller?.enqueue(encoder.encode('event: end\ndata: {}\n\n'))
        controller?.close()
      },
      setCancelStatus: (status: number) => { cancelStatus = status },
      holdRunResponse: () => {
        runResponseGate = new Promise<void>((resolve) => { releaseRunResponse = resolve })
      },
      releaseRunResponse: () => releaseRunResponse?.(),
      cancelBodies,
    }
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/agent/run')) {
        await runResponseGate
        return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c } }), {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      if (url.endsWith('/agent/cancel')) {
        cancelBodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify(cancelStatus === 200
          ? { ok: true }
          : { code: 'signal-failed', error: 'could not signal the active agent run' }), {
          status: cancelStatus,
          headers: { 'content-type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }
  })
}

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

test('pressing / opens the box and streams a transcript', async ({ page }) => {
  await page.route('**/agent/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        dataFrame({ type: 'started' }),
        dataFrame({ type: 'text', text: 'Looking at your cards.' }),
        dataFrame({ type: 'tool', name: 'read_map', summary: '' }),
        dataFrame({ type: 'done', reply: 'Found two weak spots.' }),
      ]),
    }),
  )

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  const box = page.locator('.elves-agentbox')
  await expect(box).toBeVisible()
  // With nothing selected, the scope reads whole-canvas.
  await expect(page.getByTestId('agent-scope')).toHaveText('Whole canvas')

  await page.getByTestId('agent-input').fill('critique my argument')
  await page.getByTestId('agent-send').click()

  const transcript = page.getByTestId('agent-transcript')
  await expect(transcript).toContainText('Looking at your cards.')
  // The tool name renders with underscores turned to spaces.
  await expect(transcript).toContainText('read map')
})

test('the submitted message is pinned above the tool calls and replies', async ({ page }) => {
  await page.route('**/agent/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        dataFrame({ type: 'started' }),
        dataFrame({ type: 'tool', name: 'read_map', summary: '' }),
        dataFrame({ type: 'done', reply: 'Found two weak spots.' }),
      ]),
    }),
  )

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('critique my argument')
  await page.getByTestId('agent-send').click()

  // The user's message renders as its own line, and it sits above the tool call.
  const userMsg = page.locator('.elves-agentbox__user')
  await expect(userMsg).toHaveText('critique my argument')
  const lines = page.locator('.elves-agentbox__transcript > *')
  await expect(lines.first()).toHaveClass(/elves-agentbox__user/)
})

test('the input grows to fit a multi-line message', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  const input = page.getByTestId('agent-input')
  await input.fill('one line')
  const short = await input.evaluate((el) => (el as HTMLTextAreaElement).offsetHeight)

  await input.fill('one\ntwo\nthree\nfour\nfive')
  const tall = await input.evaluate((el) => (el as HTMLTextAreaElement).offsetHeight)

  expect(tall).toBeGreaterThan(short)
})

test('a long prompt keeps the full agent box usable in a short viewport', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 800, height: 220 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  const box = page.locator('.elves-agentbox')
  const header = page.locator('.elves-agentbox__header')
  const input = page.getByTestId('agent-input')
  const actions = page.locator('.elves-agentbox__actions')
  await input.fill(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))

  for (const surface of [box, header, input, actions]) {
    const bounds = await surface.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(220)
  }

  await page.getByTestId('agent-collapse').click()
  await expect(box).toBeHidden()
})

test('/ is a literal slash while typing in the box, not a re-trigger', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  const input = page.getByTestId('agent-input')
  await input.click()
  await page.keyboard.type('a/b')
  await expect(input).toHaveValue('a/b')
})

test('/ while editing a card is a literal slash, not a box trigger', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // A new prose card drops straight into editing (its textarea is focused).
  await page.getByTestId('new-prose').click()
  const editor = page.locator('.elves-card__editor')
  await expect(editor).toBeFocused()

  await page.keyboard.type('a/b')
  // The slash typed into the card, and the box never opened.
  await expect(editor).toHaveValue('a/b')
  await expect(page.locator('.elves-agentbox')).toBeHidden()
})

test('Esc closes the box', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  await expect(page.locator('.elves-agentbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.elves-agentbox')).toBeHidden()
})

test('Cancel stays cancelling and blocks resubmission until the run stream ends', async ({ page }) => {
  let endRun!: () => void
  const runMayEnd = new Promise<void>((resolve) => { endRun = resolve })
  await page.route('**/agent/run', async (route) => {
    await runMayEnd
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        dataFrame({ type: 'started' }),
        dataFrame({ type: 'done', reply: 'Cancelled.' }),
      ]),
    })
  })
  let cancelHit = false
  await page.route('**/agent/cancel', (route) => {
    cancelHit = true
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('dedupe everything')
  await page.getByTestId('agent-send').click()

  const cancel = page.getByTestId('agent-cancel')
  await expect(cancel).toBeVisible()
  await cancel.click()
  await expect(cancel).toHaveText('Cancelling…')
  await expect(cancel).toBeDisabled()
  await expect(page.getByTestId('agent-input')).toBeDisabled()
  await expect(page.getByTestId('agent-send')).toBeHidden()
  await expect.poll(() => cancelHit).toBe(true)

  endRun()
  await expect(page.getByTestId('agent-send')).toBeVisible()
  await expect(page.getByTestId('agent-input')).toBeEnabled()
})

test('collapse shrinks the box to a live status bar and clicking it expands again', async ({ page }) => {
  // Keep the response pending so the run is genuinely live while collapsed.
  let endRun!: () => void
  const runMayEnd = new Promise<void>((resolve) => { endRun = resolve })
  await page.route('**/agent/run', async (route) => {
    await runMayEnd
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        dataFrame({ type: 'started' }),
        dataFrame({ type: 'done', reply: 'Done.' }),
      ]),
    })
  })

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('read my cards')
  await page.getByTestId('agent-send').click()

  // Collapse to the bar — the full box hides, the bar shows the pending activity.
  await page.getByTestId('agent-collapse').click()
  const bar = page.getByTestId('agent-collapsed')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('Thinking')
  await expect(page.getByTestId('agent-transcript')).toBeHidden()

  // Collapsing did not cancel: the run is still going (Cancel still offered once
  // expanded). Click the bar to expand back to the full box.
  await bar.click()
  await expect(page.getByTestId('agent-transcript')).toBeVisible()
  await expect(page.getByTestId('agent-cancel')).toBeVisible()
  await expect(bar).toBeHidden()

  endRun()
  await expect(page.getByTestId('agent-send')).toBeVisible()
})

test('the clear button empties the transcript and closes the box', async ({ page }) => {
  await page.route('**/agent/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        dataFrame({ type: 'started' }),
        dataFrame({ type: 'text', text: 'Looking at your cards.' }),
        dataFrame({ type: 'done', reply: 'Found two weak spots.' }),
      ]),
    }),
  )

  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('critique my argument')
  await page.getByTestId('agent-send').click()

  const transcript = page.getByTestId('agent-transcript')
  await expect(transcript).toBeVisible()
  await expect(transcript).toContainText('Looking at your cards.')

  await page.getByTestId('agent-clear').click()
  await expect(page.locator('.elves-agentbox')).toBeHidden()

  await page.keyboard.press('/')
  await expect(page.locator('.elves-agentbox')).toBeVisible()
  await expect(page.getByTestId('agent-transcript')).toBeHidden()
})

test('clear and reopen stays locked to the live run until its stream ends', async ({ page }) => {
  await installAgentStream(page)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('keep working')
  await page.getByTestId('agent-send').click()
  await page.evaluate(() => (window as any).__agentTest.push({ type: 'started' }))

  await page.getByTestId('agent-clear').click()
  await page.keyboard.press('/')
  await expect(page.getByTestId('agent-cancel')).toHaveText('Cancelling…')
  await expect(page.getByTestId('agent-input')).toBeDisabled()
  await page.evaluate(() => (window as any).__agentTest.push({ type: 'text', text: 'stale reply' }))
  await expect(page.getByTestId('agent-transcript')).not.toContainText('stale reply')
  expect(await page.evaluate(() => (window as any).__agentTest.cancelBodies)).toEqual([
    { runId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
  ])

  await page.evaluate(() => (window as any).__agentTest.end())
  await expect(page.getByTestId('agent-send')).toBeVisible()
})

test('clear before the run response still stays locked until the eventual stream ends', async ({ page }) => {
  await installAgentStream(page)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.evaluate(() => (window as any).__agentTest.holdRunResponse())
  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('start slowly')
  await page.getByTestId('agent-send').click()

  await page.getByTestId('agent-clear').click()
  await page.keyboard.press('/')
  await expect(page.getByTestId('agent-cancel')).toHaveText('Cancelling…')
  await expect(page.getByTestId('agent-input')).toBeDisabled()

  await page.evaluate(() => (window as any).__agentTest.releaseRunResponse())
  await page.evaluate(() => (window as any).__agentTest.push({ type: 'started' }))
  await expect(page.getByTestId('agent-cancel')).toHaveText('Cancelling…')
  await page.evaluate(() => (window as any).__agentTest.end())
  await expect(page.getByTestId('agent-send')).toBeVisible()
})

test('a failed cancel is shown and can be retried while the stream stays live', async ({ page }) => {
  await installAgentStream(page)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.evaluate(() => (window as any).__agentTest.setCancelStatus(503))
  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('try to stop')
  await page.getByTestId('agent-send').click()
  await page.evaluate(() => (window as any).__agentTest.push({ type: 'started' }))

  await page.getByTestId('agent-cancel').click()
  await expect(page.getByTestId('agent-transcript')).toContainText('could not signal the active agent run')
  await expect(page.getByTestId('agent-cancel')).toHaveText('Cancel')
  await expect(page.getByTestId('agent-cancel')).toBeEnabled()

  await page.evaluate(() => (window as any).__agentTest.setCancelStatus(200))
  await page.getByTestId('agent-cancel').click()
  await expect(page.getByTestId('agent-cancel')).toHaveText('Cancelling…')
  await page.evaluate(() => {
    ;(window as any).__agentTest.push({ type: 'done', reply: 'Cancelled.' })
    ;(window as any).__agentTest.end()
  })
  await expect(page.getByTestId('agent-send')).toBeVisible()
})
