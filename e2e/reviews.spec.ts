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

test('summoning a reviewer creates a pending pass; cancelling clears it', async ({ page, request }) => {
  await openCanvas(page)

  await page.getByTestId('review-button').click()
  await page.getByTestId('review-focus').fill('just the opening')
  await page.getByTestId('review-summon-devils-advocate').click()

  // The pass shows up in the open panel as pending, with the how-to hint.
  const pass = page.getByTestId('review-pass-devils-advocate')
  await expect(pass).toBeVisible()
  await expect(pass).toHaveAttribute('data-status', 'pending')
  await expect(pass).toContainText('just the opening')
  await expect(page.getByTestId('review-hint')).toBeVisible()

  // And on the server, where an agent's list_reviews will find it.
  const { reviews } = await (await request.get(`${BASE}/projects/${projectId}/reviews`)).json()
  const pending = reviews.filter((r: any) => r.status === 'pending')
  expect(pending).toHaveLength(1)
  expect(pending[0].personality).toBe('devils-advocate')
  expect(pending[0].focus).toBe('just the opening')

  // Cancel from the panel.
  await page.getByTestId('review-dismiss-devils-advocate').click()
  await expect(pass).toHaveCount(0)
})

test('a full pass — claim, tagged comment, verdict — reports live in the panel', async ({ page, request }) => {
  await openCanvas(page)
  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)
  // Finish the newly-created card's edit session before the simulated agent
  // writes. Current clients deliberately defer remote snapshot loads while the
  // user is typing so an agent update cannot discard unsaved keystrokes.
  await page.keyboard.press('Escape')

  // Summon from the panel…
  await page.getByTestId('review-button').click()
  await page.getByTestId('review-summon-trimmer').click()
  await expect(page.getByTestId('review-pass-trimmer')).toHaveAttribute('data-status', 'pending')
  const { reviews } = await (await request.get(`${BASE}/projects/${projectId}/reviews`)).json()
  const review = reviews.find((r: any) => r.status === 'pending')

  // …then play the agent over the same HTTP surface the MCP uses: claim,
  // leave one comment tagged with the pass, complete with a verdict.
  await request.post(`${BASE}/projects/${projectId}/reviews/${review.id}/status`, {
    data: { status: 'in-progress', agent: 'claude' },
  })
  await expect(page.getByTestId('review-pass-trimmer')).toHaveAttribute('data-status', 'in-progress')

  await request.post(`${BASE}/projects/${projectId}/changeset`, {
    data: {
      id: `cs-${Date.now()}`,
      author: 'claude',
      ops: [{
        kind: 'add_comment',
        cardId,
        comment: { type: 'tighten', text: 'same point twice — keep the concrete one', reviewId: review.id },
      }],
    },
  })
  await request.post(`${BASE}/projects/${projectId}/reviews/${review.id}/status`, {
    data: { status: 'done', verdict: 'Lean already; one duplicated point.' },
  })

  // The panel reports the finished pass: verdict + live tally.
  const pass = page.getByTestId('review-pass-trimmer')
  await expect(pass).toHaveAttribute('data-status', 'done')
  await expect(page.getByTestId('review-verdict')).toContainText('one duplicated point')
  await expect(page.getByTestId('review-tally-trimmer')).toContainText('1 open · 1 notes')

  // The tagged comment renders on the card in its own (new) type styling.
  const pin = page.locator('.elves-comment[data-type="tighten"]')
  await expect(pin).toBeVisible()
  await expect(pin).toContainText('same point twice')

  // Resolving the comment drains the live tally. (Clicking on the canvas
  // closes the dropdown, like any popover — reopen it to read the tally.)
  await page.getByTestId('comment-resolve').first().click()
  await page.getByTestId('review-button').click()
  await expect(page.getByTestId('review-tally-trimmer')).toHaveText('1 notes')
})
