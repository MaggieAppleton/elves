import { test, expect } from '@playwright/test'
import { resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  // Ensure a project exists and reset its canvas so tests don't bleed together.
  await resetProject(request)
})

for (const card of [
  { name: 'prose', button: 'new-prose', selector: '.elves-card--prose' },
  { name: 'note', button: 'new-note', selector: '.elves-card--note' },
  { name: 'figure', button: 'new-figure', selector: '.elves-card--figure' },
] as const) {
  test(`toolbar-created ${card.name} cards appear at the viewport centre`, async ({ page }) => {
    await page.goto('/')
    const canvas = page.locator('.tl-canvas')
    await expect(canvas).toBeVisible({ timeout: 15000 })

    // Leave a card at the centre. The next card must stay visible there rather
    // than being pushed below this obstacle and down the rest of its lane.
    await page.getByTestId('new-prose').click()
    await page.keyboard.press('Escape')
    const cards = page.locator(card.selector)
    const previousCount = await cards.count()
    await page.getByTestId(card.button).click()

    await expect(cards).toHaveCount(previousCount + 1)
    const created = cards.nth(previousCount)
    await expect(created).toBeVisible()
    const [canvasBox, cardBox] = await Promise.all([
      canvas.boundingBox(),
      created.boundingBox(),
    ])
    if (!canvasBox || !cardBox) throw new Error('canvas or created card has no bounds')

    expect(Math.abs(
      cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
    )).toBeLessThanOrEqual(2)
    expect(Math.abs(
      cardBox.y + cardBox.height / 2 - (canvasBox.y + canvasBox.height / 2),
    )).toBeLessThanOrEqual(2)
  })
}

test('create a prose card, type into it, and it survives reload', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  const card = page.locator('.elves-card--prose').first()
  await expect(card).toBeVisible()

  // The button drops the new card straight into editing, so no click/dblclick
  // is needed to reach the textarea (see e2e/figures.spec.ts for the same pattern).
  await page.locator('.elves-card__editor').fill('composition was the bottleneck')
  await page.mouse.click(50, 50) // click empty canvas to commit
  await expect(card.getByTestId('card-text')).toHaveText('composition was the bottleneck')

  await page.waitForTimeout(800) // allow debounced save
  await page.reload()
  await expect(
    page.locator('.elves-card--prose').getByText('composition was the bottleneck'),
  ).toBeVisible({ timeout: 15000 })
})

test('note card is muted and shows its Note badge', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-note').click()
  const source = page.locator('.elves-card--note').first()
  await expect(source).toBeVisible()
  await expect(source.getByTestId('card-badge')).toHaveText('Note')
})

test('convert a text note to prose: badge flips and it enters the draft', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  // Make a text note and give it some words.
  await page.getByTestId('new-note').click()
  const note = page.locator('.elves-card--note').first()
  await expect(note).toBeVisible()
  const box = await note.boundingBox()
  if (!box) throw new Error('note card not in DOM')
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.dblclick(cx, cy)
  await page.locator('.elves-card__editor').fill('a thought promoted into the piece')
  await page.mouse.click(50, 50) // commit

  // Select the note so its badge-row Convert action appears, then convert.
  await page.mouse.click(cx, cy)
  await page.getByTestId('convert-to-prose').click()

  // The card is now prose: badge reads Prose, and the Note face is gone.
  const prose = page.locator('.elves-card--prose').first()
  await expect(prose).toBeVisible()
  await expect(prose.getByTestId('card-badge')).toHaveText('Prose')
  await expect(page.locator('.elves-card--note')).toHaveCount(0)

  // Prose compiles into the linear draft (notes never do).
  await page.getByTestId('draft-open').click()
  await expect(page.getByTestId('draft-para')).toHaveText('a thought promoted into the piece')
})
