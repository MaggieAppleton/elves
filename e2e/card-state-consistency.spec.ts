import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

// Regression guard for the "janky" state shifts: selecting a note/prose card
// (which reveals the convert switch button in the badge row) and then entering
// edit (div -> textarea) must NOT move the badge label or the body text. We
// measure the top edge of both across default / selected / editing and require
// them to hold still to within a subpixel tolerance.
test('note card layout stays fixed across default, selected, and editing', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // A note with a couple of lines so a downward text shift is obvious.
  await page.getByTestId('new-note').click()
  const card = page.locator('.elves-card--note').first()
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  if (!box) throw new Error('note card not in DOM')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.dblclick(cx, cy)
  await page.locator('.elves-card__editor').fill('a first line of the note\nand a second line below it')
  await page.mouse.click(50, 50) // commit + deselect

  const topOf = async (sel: string) => {
    const b = await page.locator(sel).first().boundingBox()
    if (!b) throw new Error(`${sel} not in DOM`)
    return b.y
  }

  // Default (deselected): read view.
  await expect(page.getByTestId('convert-to-prose')).toHaveCount(0)
  const badgeDefault = await topOf('[data-testid="card-badge"]')
  const textDefault = await topOf('[data-testid="card-text"]')

  // Selected: the convert switch button appears in the badge row.
  await page.mouse.click(cx, cy)
  await expect(page.getByTestId('convert-to-prose')).toBeVisible()
  const badgeSelected = await topOf('[data-testid="card-badge"]')
  const textSelected = await topOf('[data-testid="card-text"]')

  // Editing: the read div is swapped for the textarea.
  await page.mouse.dblclick(cx, cy)
  await expect(page.locator('.elves-card__editor')).toBeVisible()
  const badgeEditing = await topOf('[data-testid="card-badge"]')
  const textEditing = await topOf('.elves-card__editor')

  const TOL = 1.5 // px — allow subpixel rounding, catch the ~2-5px real shifts
  expect(Math.abs(badgeSelected - badgeDefault), 'badge moved on select').toBeLessThanOrEqual(TOL)
  expect(Math.abs(badgeEditing - badgeDefault), 'badge moved on edit').toBeLessThanOrEqual(TOL)
  expect(Math.abs(textSelected - textDefault), 'body text moved on select').toBeLessThanOrEqual(TOL)
  expect(Math.abs(textEditing - textDefault), 'body text moved on edit').toBeLessThanOrEqual(TOL)
})
