import { readFileSync } from 'node:fs'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { resetProject, serverCardIds } from './helpers'

let projectId: string
const imageBase64 = readFileSync('e2e/fixtures/handwriting.png').toString('base64')

async function dispatchImage(
  target: Locator,
  type: 'drop' | 'paste',
  name: string,
) {
  await target.evaluate((element, { imageBase64, type, name }) => {
    const bytes = Uint8Array.from(atob(imageBase64), (char) => char.charCodeAt(0))
    const file = new File([bytes], name, { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    if (type === 'drop') {
      const bounds = element.getBoundingClientRect()
      element.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.y,
      }))
      return
    }
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: transfer })
    element.dispatchEvent(event)
  }, { imageBase64, type, name })
}

async function addProse(page: Page, text: string) {
  await page.getByTestId('new-prose').click()
  const editor = page.locator('.elves-card__editor')
  await expect(editor).toBeVisible()
  await editor.fill(text)
  await page.mouse.click(50, 100)
  await expect(page.getByTestId('card-text').filter({ hasText: text })).toBeVisible()
}
test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('adding an image creates an image note card that renders and persists', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-image')).toBeEnabled()

  await page.getByTestId('image-input').setInputFiles('e2e/fixtures/handwriting.png')

  const img = page.locator('img.elves-card__image')
  await expect(img).toBeVisible({ timeout: 10000 })
  await expect(img).toHaveAttribute('src', /\/projects\/.+\/assets\/.+\.png$/)

  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  await page.reload()
  await expect(page.locator('img.elves-card__image')).toBeVisible({ timeout: 15000 })
})

test('canvas drop and paste create separate persistent image cards', async ({ page, request }) => {
  await page.goto('/')
  const canvas = page.locator('.tl-canvas')
  await expect(canvas).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-image')).toBeEnabled()

  await dispatchImage(canvas, 'drop', 'dropped.png')
  await expect(page.locator('img.elves-card__image')).toHaveCount(1)

  await canvas.click({ position: { x: 80, y: 120 } })
  await canvas.evaluate(() => {
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, 'read', { value: undefined, configurable: true })
    }
  })
  await dispatchImage(canvas, 'paste', 'pasted.png')
  await expect(page.locator('img.elves-card__image')).toHaveCount(2)
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(2)

  const boxes = await page.locator('.elves-card--image').evaluateAll((cards) =>
    cards.map((card) => card.getBoundingClientRect()).map(({ x, y, width, height }) =>
      ({ x, y, width, height })),
  )
  expect(boxes[0].y + boxes[0].height <= boxes[1].y || boxes[1].y + boxes[1].height <= boxes[0].y)
    .toBe(true)

  await page.reload()
  await expect(page.locator('img.elves-card__image')).toHaveCount(2, { timeout: 15000 })
})

test('draft paste and drop insert images at their narrative positions', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('new-image')).toBeEnabled()
  await addProse(page, 'First paragraph')
  await addProse(page, 'Second paragraph')
  await page.getByTestId('draft-open').click()

  const paragraphs = page.getByTestId('draft-para')
  await paragraphs.first().locator('button[aria-label="Edit paragraph"]').focus()
  await dispatchImage(paragraphs.first(), 'paste', 'inline-paste.png')
  await expect(page.getByTestId('draft-image')).toHaveCount(1)

  const lastGap = page.locator('[data-draft-gap]').last()
  await dispatchImage(lastGap, 'drop', 'inline-drop.png')
  await expect(page.getByTestId('draft-image')).toHaveCount(2)

  const order = await page.locator('.elves-draft__body').evaluate((body) =>
    [...body.querySelectorAll('[data-testid="draft-para"], [data-testid="draft-image-block"]')]
      .map((item) => item.getAttribute('data-testid')),
  )
  expect(order).toEqual([
    'draft-para', 'draft-image-block', 'draft-para', 'draft-image-block',
  ])

  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(4)
  await page.reload()
  await expect(page.getByTestId('draft-image')).toHaveCount(2, { timeout: 15000 })
})
