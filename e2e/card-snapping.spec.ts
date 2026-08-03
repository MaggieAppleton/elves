import { test, expect, type Locator, type Page } from '@playwright/test'
import { resetProject } from './helpers'

// The gap cards settle into, from CANVAS_GAP in src/model/layout.ts.
const GAP = 16

// Long enough to force the card it is typed into onto several extra lines.
const LONG = `Once you have the shape of the story mapped out, and all your major plot points in roughly the right position, it's time to move into a linear flow.

Because eventually, all writing has to become a linear experience.`

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

async function boxOf(card: Locator) {
  const box = await card.boundingBox()
  if (!box) throw new Error('card has no bounds')
  return box
}

/** Drag a card so its top-left lands on `to`, grabbing it near its own corner. */
async function dragCardTo(page: Page, card: Locator, to: { x: number; y: number }) {
  const box = await boxOf(card)
  const grab = { x: box.x + 10, y: box.y + 6 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  // Several steps so tldraw registers a drag rather than a click, and so the
  // snap has frames in which to engage the way it would under a real pointer.
  await page.mouse.move(grab.x + (to.x - box.x), grab.y + (to.y - box.y), { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => {
    const moved = await boxOf(card)
    return Math.hypot(moved.x - box.x, moved.y - box.y)
  }).toBeGreaterThan(1)
}

test('a card dragged near another snaps to a clean gap below it', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')

  const anchor = page.locator('.elves-card--prose').first()
  const mover = page.locator('.elves-card--note').first()
  await expect(anchor).toBeVisible()
  await expect(mover).toBeVisible()

  // Park the mover well clear of the anchor so the snap has somewhere to pull
  // it back from, and so we are not just re-measuring its spawn position.
  const away = await boxOf(anchor)
  await dragCardTo(page, mover, { x: away.x + 420, y: away.y + 380 })

  // Now aim 12px off the true slot — inside the snap radius, but visibly wrong
  // if nothing pulls it into line.
  const anchorBox = await boxOf(anchor)
  await dragCardTo(page, mover, {
    x: anchorBox.x + 12,
    y: anchorBox.y + anchorBox.height + GAP + 12,
  })

  const [a, m] = [await boxOf(anchor), await boxOf(mover)]
  expect(Math.abs(m.x - a.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(m.y - (a.y + a.height + GAP))).toBeLessThanOrEqual(1)
})

test('a snapped column keeps its gap when the card above grows', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')

  const anchor = page.locator('.elves-card--prose').first()
  const mover = page.locator('.elves-card--note').first()
  await expect(mover).toBeVisible()

  // Build the stack: park the mover away, then snap it under the anchor.
  const start = await boxOf(anchor)
  await dragCardTo(page, mover, { x: start.x + 420, y: start.y + 380 })
  const anchorBox = await boxOf(anchor)
  await dragCardTo(page, mover, {
    x: anchorBox.x,
    y: anchorBox.y + anchorBox.height + GAP,
  })
  const beforeHeight = (await boxOf(anchor)).height

  // Write into the top card until it has to grow.
  const grab = await boxOf(anchor)
  await page.mouse.dblclick(grab.x + grab.width / 2, grab.y + 20)
  await page.locator('.elves-card__editor').fill(LONG)
  await page.mouse.click(50, 50)

  const grown = await boxOf(anchor)
  expect(grown.height).toBeGreaterThan(beforeHeight)

  // The card below must have been pushed down to preserve the gap rather than
  // being overlapped by the text that just appeared above it.
  await expect.poll(async () => {
    const [a, m] = [await boxOf(anchor), await boxOf(mover)]
    return Math.round(m.y - (a.y + a.height))
  }, { timeout: 5000 }).toBeLessThanOrEqual(GAP + 1)
  const [a, m] = [await boxOf(anchor), await boxOf(mover)]
  expect(m.y - (a.y + a.height)).toBeGreaterThanOrEqual(GAP - 1)
})

test('dropping into an occupied snap slot inserts the card into the column', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.locator('.elves-card--note .elves-card__editor').last().fill('Occupant')
  await page.keyboard.press('Escape')

  const anchor = page.locator('.elves-card--prose').first()
  const occupant = page.locator('.elves-card--note').filter({ hasText: 'Occupant' })
  await expect(occupant).toBeVisible()

  // Build the two-card column before creating the third card, so the initial
  // cascade does not leave two notes overlapping under the pointer.
  const anchorBox = await boxOf(anchor)
  const occupiedSlot = {
    x: anchorBox.x,
    y: anchorBox.y + anchorBox.height + GAP,
  }
  await dragCardTo(page, occupant, occupiedSlot)

  await page.getByTestId('new-note').click()
  await page.locator('.elves-card--note .elves-card__editor').last().fill('Mover')
  await page.keyboard.press('Escape')
  const mover = page.locator('.elves-card--note').filter({ hasText: 'Mover' })
  await expect(mover).toBeVisible()
  await dragCardTo(page, mover, { x: anchorBox.x - 250, y: anchorBox.y + 250 })

  // Dropping the mover into that same snap slot should splice it into the
  // column, moving the former occupant down instead of stacking the cards.
  await dragCardTo(page, mover, occupiedSlot)

  const [a, inserted, shifted] = [
    await boxOf(anchor),
    await boxOf(mover),
    await boxOf(occupant),
  ]
  expect(Math.abs(inserted.x - a.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(inserted.y - (a.y + a.height + GAP))).toBeLessThanOrEqual(1)
  expect(Math.abs(shifted.x - inserted.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(shifted.y - (inserted.y + inserted.height + GAP))).toBeLessThanOrEqual(1)
})

test('the snap halo clears out of range, on cancel, and on release', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')

  const anchor = page.locator('.elves-card--prose').first()
  const mover = page.locator('.elves-card--note').first()
  const halo = page.locator('.elves-snap-halo')
  await expect(mover).toBeVisible()

  const start = await boxOf(anchor)
  await dragCardTo(page, mover, { x: start.x + 420, y: start.y + 380 })
  await expect(halo).toHaveCount(0)

  // Pick the card up and hold it out of range: no snap, so no halo.
  const anchorBox = await boxOf(anchor)
  const moverBox = await boxOf(mover)
  const grab = { x: moverBox.x + 10, y: moverBox.y + 6 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(anchorBox.x + 300, anchorBox.y + 300, { steps: 8 })
  await expect(halo).toHaveCount(0)

  // Now move into range without releasing — the halo must show the pairing
  // before the drop, which is the whole point of the affordance.
  const slot = { x: anchorBox.x, y: anchorBox.y + anchorBox.height + GAP }
  await page.mouse.move(
    grab.x + (slot.x - moverBox.x),
    grab.y + (slot.y - moverBox.y),
    { steps: 12 },
  )
  await expect(halo).toBeVisible()

  const [haloBox, a, m] = [await boxOf(halo), await boxOf(anchor), await boxOf(mover)]
  // It must contain BOTH cards, not just the one being dragged.
  expect(haloBox.x).toBeLessThanOrEqual(Math.min(a.x, m.x))
  expect(haloBox.y).toBeLessThanOrEqual(Math.min(a.y, m.y))
  expect(haloBox.x + haloBox.width).toBeGreaterThanOrEqual(Math.max(a.x + a.width, m.x + m.width))
  expect(haloBox.y + haloBox.height).toBeGreaterThanOrEqual(Math.max(a.y + a.height, m.y + m.height))

  // Drag back out of range while still held: the halo goes, which is how
  // "you have left the stack" reads. Re-enter before testing cancellation.
  await page.mouse.move(anchorBox.x + 400, anchorBox.y + 400, { steps: 10 })
  await expect(halo).toHaveCount(0)
  await page.mouse.move(
    grab.x + (slot.x - moverBox.x),
    grab.y + (slot.y - moverBox.y),
    { steps: 12 },
  )
  await expect(halo).toBeVisible()

  // Escape takes tldraw's cancellation path rather than its drag-end path.
  // The halo must clear and the card must return to its pre-drag position.
  await page.keyboard.press('Escape')
  await expect(halo).toHaveCount(0)
  const cancelled = await boxOf(mover)
  expect(Math.abs(cancelled.x - moverBox.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(cancelled.y - moverBox.y)).toBeLessThanOrEqual(1)

  // A subsequent snap that completes normally still clears on release.
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(
    grab.x + (slot.x - moverBox.x),
    grab.y + (slot.y - moverBox.y),
    { steps: 12 },
  )
  await expect(halo).toBeVisible()
  await page.mouse.up()
  await expect(halo).toHaveCount(0)
})

test('a card dragged clear of the stack keeps the position it was dropped at', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('new-prose').click()
  await page.keyboard.press('Escape')
  await page.getByTestId('new-note').click()
  await page.keyboard.press('Escape')

  const anchor = page.locator('.elves-card--prose').first()
  const mover = page.locator('.elves-card--note').first()
  await expect(mover).toBeVisible()

  const anchorBox = await boxOf(anchor)
  const target = { x: anchorBox.x + 500, y: anchorBox.y + 460 }
  await dragCardTo(page, mover, target)

  // Far from every slot, so the drop position stands rather than being pulled
  // into the anchor's column — this is what "drag it away to ungroup" means.
  const m = await boxOf(mover)
  expect(Math.abs(m.x - target.x)).toBeLessThanOrEqual(2)
  expect(Math.abs(m.y - target.y)).toBeLessThanOrEqual(2)
})
