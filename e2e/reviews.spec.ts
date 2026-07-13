import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, resetProject, serverCardIds } from './helpers'

let projectId: string

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

  // The tagged comment renders on the card in its own type styling.
  const pin = page.locator('.elves-comment[data-type="tighten"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('stub note')

  await expect(
    page.getByRole('button', {
      name: /^Clear The Trimmer review from panel: requested /,
    }),
  ).toBeVisible()

  // The old "wait for an external agent" hint is gone entirely — the app runs
  // the pass itself now.
  await expect(page.getByTestId('review-hint')).toHaveCount(0)
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
  await expect(page.getByRole('button', {
    name: /^Clear failed Devil's Advocate review from panel: __fail__; requested .+; pass 1 of 1$/,
  })).toBeVisible()
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
