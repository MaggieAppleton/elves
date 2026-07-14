import { test, expect, type Locator, type Page } from '@playwright/test'
import { BASE, resetProject } from './helpers'

async function expectInsideViewport(page: Page, locator: Locator): Promise<void> {
  const viewport = page.viewportSize()
  const box = await locator.boundingBox()
  expect(viewport).not.toBeNull()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
}

async function expectInside(locator: Locator, container: Locator): Promise<void> {
  const [box, containerBox] = await Promise.all([locator.boundingBox(), container.boundingBox()])
  expect(box).not.toBeNull()
  expect(containerBox).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(containerBox!.x)
  expect(box!.y).toBeGreaterThanOrEqual(containerBox!.y)
  expect(box!.x + box!.width).toBeLessThanOrEqual(containerBox!.x + containerBox!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(containerBox!.y + containerBox!.height)
}

test.beforeEach(async ({ request }) => {
  await resetProject(request)
})

test('app boots and mounts the tldraw canvas', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
})

test('topbar controls stay reachable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  const creationButtons = [
    'new-prose',
    'new-note',
    'new-image',
    'new-reference',
    'new-figure',
    'new-section',
  ]
  await expectInsideViewport(page, page.locator('.elves-toolbar'))
  for (const testId of creationButtons) {
    const button = page.getByTestId(testId)
    await expectInsideViewport(page, button)
    const box = await button.boundingBox()
    expect(box!.width).toBeGreaterThanOrEqual(40)
    expect(box!.height).toBeGreaterThanOrEqual(40)
  }

  // Exercise the real pointer targets and their effects; visibility alone does
  // not prove a control's centre is on-screen or free from another overlay.
  await page.getByTestId('new-prose').click()
  await expect(page.locator('.elves-card--prose')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByTestId('new-note').click()
  await expect(page.locator('.elves-card--note')).toHaveCount(1)
  await page.keyboard.press('Escape')

  const fileChooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('new-image').click()
  const fileChooser = await fileChooserPromise
  await fileChooser.setFiles('e2e/fixtures/handwriting.png')
  await expect(page.locator('img.elves-card__image')).toBeVisible()

  await page.getByTestId('new-reference').click()
  await expect(page.getByTestId('link-prompt')).toBeVisible()
  await page.getByTestId('link-prompt-cancel').click()

  await page.getByTestId('new-figure').click()
  await expect(page.locator('.elves-card--figure')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByTestId('new-section').click()
  await expect(page.locator('.elves-section')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await expectInsideViewport(page, page.getByTestId('review-button'))
  await expectInsideViewport(page, page.getByTestId('project-switcher'))

  await page.getByTestId('review-button').click()
  const reviewMenu = page.getByTestId('review-menu')
  await expect(reviewMenu).toBeVisible()
  await expectInsideViewport(page, reviewMenu)
  await page.keyboard.press('Escape')

  await page.getByTestId('project-switcher').click()
  const projectMenu = page.locator('.elves-switcher__menu')
  await expect(projectMenu).toBeVisible()
  await expectInsideViewport(page, projectMenu)
})

test('creation toolbar stays reachable inside a narrow split canvas pane', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
  await page.getByTestId('draft-open').click()
  await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')

  const pane = page.locator('.elves-canvas-pane')
  const toolbar = page.locator('.elves-toolbar')
  await expect.poll(async () => (await pane.boundingBox())?.width ?? Infinity).toBeLessThan(200)
  await expectInside(toolbar, pane)
  expect(await toolbar.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

  const creationButtons = [
    'new-prose',
    'new-note',
    'new-image',
    'new-reference',
    'new-figure',
    'new-section',
  ]
  const focusClearance = 4.5 // 1px border + 4px padding, allowing subpixel rounding.
  await page.getByTestId(creationButtons[0]).focus()
  for (const [index, testId] of creationButtons.entries()) {
    const button = page.getByTestId(testId)
    await expect(button).toBeFocused()
    await expect.poll(async () => {
      const [buttonBox, toolbarBox] = await Promise.all([button.boundingBox(), toolbar.boundingBox()])
      if (!buttonBox || !toolbarBox) return false
      return buttonBox.x >= toolbarBox.x + focusClearance &&
        buttonBox.x + buttonBox.width <= toolbarBox.x + toolbarBox.width - focusClearance
    }, { message: `${testId} should scroll fully inside the toolbar with room for its focus ring` })
      .toBe(true)
    if (index < creationButtons.length - 1) await page.keyboard.press('Tab')
  }
})

test.describe('touch creation toolbar', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 800 } })

  test('swipes to and taps controls at both ends of a narrow split toolbar', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })
    await page.getByTestId('draft-open').tap()
    await expect(page.locator('.elves-stage')).toHaveAttribute('data-view', 'split')

    const toolbar = page.locator('.elves-toolbar')
    await page.getByTestId('new-prose').tap()
    await expect(page.locator('.elves-card--prose')).toHaveCount(1)

    const box = await toolbar.boundingBox()
    expect(box).not.toBeNull()
    const client = await page.context().newCDPSession(page)
    const y = box!.y + box!.height / 2
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: box!.x + box!.width - 12, y }],
    })
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: box!.x + 12, y }],
    })
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => toolbar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)

    const lastButton = page.getByTestId('new-section')
    await expectInside(lastButton, toolbar)
    await lastButton.tap()
    await expect(page.locator('.elves-section')).toHaveCount(1)
  })
})

test('topbar keeps its labelled desktop layout above 640px', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await expect(page.getByTestId('new-prose')).toHaveText('Prose')
  await expect(page.getByTestId('new-note')).toHaveText('Notes')
  await expect(page.getByTestId('new-image')).toHaveText('Image')
  await expect(page.getByTestId('new-reference')).toHaveText('Link')
  await expect(page.getByTestId('new-figure')).toHaveText('Figure')
  await expect(page.getByTestId('new-section')).toHaveText('Section')

  const toolbar = await page.locator('.elves-toolbar').boundingBox()
  const topbar = await page.locator('.elves-topbar').boundingBox()
  expect(toolbar).not.toBeNull()
  expect(topbar).not.toBeNull()
  expect(toolbar!.y).toBeLessThan(30)
  expect(topbar!.y).toBeLessThan(30)
  expect(toolbar!.width).toBeGreaterThan(400)
  expect(
    await page.locator('.elves-toolbar').evaluate((element) => element.scrollWidth === element.clientWidth),
  ).toBe(true)

  await page.getByTestId('review-button').click()
  await expectInsideViewport(page, page.getByTestId('review-menu'))
  await page.keyboard.press('Escape')
  await page.getByTestId('project-switcher').click()
  await expectInsideViewport(page, page.locator('.elves-switcher__menu'))
})

test('desktop menus stay contained and scrollable in a short viewport', async ({ page, request }) => {
  const stamp = Date.now()
  for (let index = 1; index <= 8; index++) {
    const response = await request.post(`${BASE}/projects`, {
      data: { name: `Short viewport ${stamp} project ${index}` },
    })
    expect(response.ok()).toBe(true)
  }

  await page.setViewportSize({ width: 1024, height: 240 })
  await page.goto('/')
  await expect(page.locator('.tl-canvas')).toBeVisible({ timeout: 15000 })

  await page.getByTestId('review-button').click()
  const reviewMenu = page.getByTestId('review-menu')
  await expectInsideViewport(page, reviewMenu)
  expect(
    await reviewMenu.evaluate((menu) => menu.scrollHeight > menu.clientHeight),
  ).toBe(true)
  const lastReviewer = page.getByTestId('review-summon-architect')
  await lastReviewer.scrollIntoViewIfNeeded()
  await expectInsideViewport(page, lastReviewer)
  expect(await reviewMenu.evaluate((menu) => menu.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('Escape')

  await page.getByTestId('project-switcher').click()
  const projectMenu = page.locator('.elves-switcher__menu')
  await expectInsideViewport(page, projectMenu)
  expect(
    await projectMenu.evaluate((menu) => menu.scrollHeight > menu.clientHeight),
  ).toBe(true)
  const lastProjectAction = page.getByTestId('project-rename')
  await lastProjectAction.scrollIntoViewIfNeeded()
  await expectInsideViewport(page, lastProjectAction)
  expect(await projectMenu.evaluate((menu) => menu.scrollTop)).toBeGreaterThan(0)
})
