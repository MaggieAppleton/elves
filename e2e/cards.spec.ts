import { test, expect } from '@playwright/test'
import { CARD_DEFAULT_W } from '../src/model/cards'
import { CASCADE_STEP, CASCADE_WRAP } from '../src/model/layout'
import { SECTION_DEFAULT_H, SECTION_DEFAULT_W } from '../src/model/sections'
import { BASE, resetProject } from './helpers'

test.beforeEach(async ({ request }) => {
  // Ensure a project exists and reset its canvas so tests don't bleed together.
  await resetProject(request)
})

for (const card of [
  { name: 'prose', button: 'new-prose', selector: '.elves-card--prose' },
  { name: 'note', button: 'new-note', selector: '.elves-card--note' },
  { name: 'figure', button: 'new-figure', selector: '.elves-card--figure' },
] as const) {
  test(`toolbar-created ${card.name} cards cascade from the viewport centre`, async ({ page }) => {
    await page.goto('/')
    const canvas = page.locator('.tl-canvas')
    await expect(canvas).toBeVisible({ timeout: 15000 })

    // The first spawn is centred; the next uses the shared cascade sequence so
    // it remains visible and selectable instead of stacking underneath it.
    await page.getByTestId('new-prose').click()
    const firstBlankCard = page.locator('.elves-card--prose').first()
    const [initialCanvasBox, initialCardBox] = await Promise.all([
      canvas.boundingBox(),
      firstBlankCard.boundingBox(),
    ])
    if (!initialCanvasBox || !initialCardBox) throw new Error('initial card has no bounds')
    expect(Math.abs(
      initialCardBox.x + initialCardBox.width / 2 -
        (initialCanvasBox.x + initialCanvasBox.width / 2),
    )).toBeLessThanOrEqual(2)
    expect(Math.abs(
      initialCardBox.y + initialCardBox.height / 2 -
        (initialCanvasBox.y + initialCanvasBox.height / 2),
    )).toBeLessThanOrEqual(2)
    await page.locator('.elves-card--prose .elves-card__editor').fill('First spawn')
    await page.keyboard.press('Escape')
    const firstCard = page.locator('.elves-card--prose', { hasText: 'First spawn' })
    await expect(firstCard).toBeVisible()
    const cards = page.locator(card.selector)
    const previousCount = await cards.count()
    await page.getByTestId(card.button).click()

    await expect(cards).toHaveCount(previousCount + 1)
    await expect(firstCard).toBeVisible()
    const created = card.name === 'prose'
      ? cards.filter({ hasNotText: 'First spawn' })
      : cards.nth(previousCount)
    await expect(created).toBeVisible()
    const [canvasBox, cardBox] = await Promise.all([
      canvas.boundingBox(),
      created.boundingBox(),
    ])
    if (!canvasBox || !cardBox) throw new Error('canvas or created card has no bounds')

    expect(
      cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
    ).toBeCloseTo(CASCADE_STEP, 0)
    expect(
      cardBox.y + cardBox.height / 2 - (canvasBox.y + canvasBox.height / 2),
    ).toBeCloseTo(CASCADE_STEP, 0)

    const firstCardBox = await firstCard.boundingBox()
    if (!firstCardBox) throw new Error('first card has no bounds')
    await page.mouse.click(firstCardBox.x + 8, firstCardBox.y + 8)
    await page.keyboard.press('Delete')
    await expect(firstCard).toHaveCount(0)
    await expect(created).toBeVisible()
  })
}

test('cards and sections advance one shared cascade sequence through its wrap', async ({ page, request }) => {
  const projectId = await resetProject(request)
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  for (let index = 0; index <= CASCADE_WRAP; index += 1) {
    const isSection = index % 2 === 1
    await page.getByTestId(isSection ? 'new-section' : 'new-prose').click()
    await page.locator(isSection ? '.elves-section__editor' : '.elves-card__editor').fill(`Spawn ${index}`)
    await page.keyboard.press('Escape')
  }

  await expect(page.locator('.elves-card', { hasText: 'Spawn 0' })).toBeVisible()
  await expect(page.locator('.elves-card', { hasText: `Spawn ${CASCADE_WRAP}` })).toBeVisible()
  await expect.poll(async () => {
    const response = await request.get(`${BASE}/projects/${projectId}/canvas`)
    const snapshot = await response.json()
    return Object.values(snapshot.document?.store ?? snapshot.document?.records ?? {})
      .filter((record: any) => record.typeName === 'shape' &&
        (record.type === 'card' || record.type === 'section')).length
  }).toBe(CASCADE_WRAP + 1)

  const response = await request.get(`${BASE}/projects/${projectId}/canvas`)
  const snapshot = await response.json()
  const records = Object.values(snapshot.document?.store ?? snapshot.document?.records ?? {}) as any[]
  const shapes = Array.from({ length: CASCADE_WRAP + 1 }, (_, index) =>
    records.find((record) => record.typeName === 'shape' && record.props?.text === `Spawn ${index}`),
  )
  expect(shapes.every(Boolean)).toBe(true)
  const placementCenterX = (shape: any) =>
    shape.x + (shape.type === 'section' ? SECTION_DEFAULT_W : CARD_DEFAULT_W) / 2
  const initialProseHeight = shapes[0].props.h
  const placementCenterY = (shape: any) =>
    shape.y + (shape.type === 'section' ? SECTION_DEFAULT_H : initialProseHeight) / 2
  const firstCenterX = placementCenterX(shapes[0])
  const firstCenterY = placementCenterY(shapes[0])
  shapes.forEach((shape, index) => {
    expect(placementCenterX(shape)).toBeCloseTo(
      firstCenterX + (index % CASCADE_WRAP) * CASCADE_STEP,
      5,
    )
    expect(placementCenterY(shape)).toBeCloseTo(
      firstCenterY + (index % CASCADE_WRAP) * CASCADE_STEP,
      5,
    )
  })
})

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
