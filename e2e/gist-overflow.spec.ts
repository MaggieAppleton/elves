import { test, expect, type Page } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

// Zoom out until a card's gist appears. tldraw zooms on a CTRL+wheel event, and
// Playwright's mouse.wheel can't set that ctrlKey flag, so we dispatch the wheel
// events ourselves toward the canvas centre. Poll rather than assume a single
// tick crosses the GIST_ZOOM (0.6) threshold.
async function zoomOutUntilGist(page: Page) {
  const gist = page.getByTestId('card-gist').first()
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => {
      const canvas = document.querySelector('.tl-canvas') || document.querySelector('.tl-container')
      if (!canvas) return
      const r = canvas.getBoundingClientRect()
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 60, ctrlKey: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      }))
    })
    await page.waitForTimeout(100)
    if (await gist.isVisible().catch(() => false)) break
  }
  await expect(gist).toBeVisible()
}

test('zoomed-out gist never overflows its card box (no overlap onto cards below)', async ({ page }) => {
  await page.goto('/')
  // Cold-start compile of the app module graph can exceed 15s on a fresh vite
  // dev server, so give the canvas generous headroom on first paint.
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 45000 })

  // A prose card whose text is long enough that, at the enlarged gist font, an
  // unfitted gist would wrap taller than the box measured for the 15px full text
  // — the exact condition that used to spill the summary over the card beneath it.
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill(
    'Canvases and agents provide new ways to interact with tools effectively, ' +
    'letting a writer summon help at will and direct focus to any area of the piece.',
  )
  await page.mouse.click(50, 50) // commit
  const card = page.locator('.elves-card--prose').first()
  await expect(card.getByTestId('card-text')).toBeVisible()

  await zoomOutUntilGist(page)

  // The gist must sit fully inside its card box — its bottom edge no lower than
  // the card's. Before the fit, the enlarged gist grew the box past the shape
  // geometry and overlapped whatever was below; now the font is fitted and the
  // box clips, so this holds.
  const cardBox = await card.boundingBox()
  const gistBox = await page.getByTestId('card-gist').first().boundingBox()
  if (!cardBox || !gistBox) throw new Error('card or gist not in DOM')
  expect(gistBox.y + gistBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height + 1)
})
