import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

// A canned SSE body — the exact frames the server would stream — so these tests
// exercise the real box (hotkey, streaming render, cancel) without spawning a
// real CLI. The client reads the whole body, splits frames on the blank line,
// and dispatches each event, so a single fulfilled response is enough.
const sse = (frames: string[]) => frames.map((f) => `${f}\n\n`).join('') + 'event: end\ndata: {}\n\n'
const dataFrame = (e: unknown) => `data: ${JSON.stringify(e)}`

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

test('Cancel appears mid-run and hits the cancel endpoint', async ({ page }) => {
  // Stream a `started` but no terminal event: the box stays in its running state
  // (Cancel showing) until the user cancels.
  await page.route('**/agent/run', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([dataFrame({ type: 'started' })]),
    }),
  )
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
  await expect(page.getByTestId('agent-send')).toBeVisible()
  expect(cancelHit).toBe(true)
})
