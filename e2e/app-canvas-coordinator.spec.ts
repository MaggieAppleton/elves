import { test, expect } from '@playwright/test'
import { BASE, resetProject } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('canvas controls stay disabled until coordinator initialization finishes', async ({ page }) => {
  let releaseLoad!: () => void
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve
  })
  let captureLoad!: () => void
  const loadCaptured = new Promise<void>((resolve) => {
    captureLoad = resolve
  })

  await page.route(
    (url) => url.pathname.endsWith('/canvas'),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      captureLoad()
      await loadGate
      await route.continue()
    },
  )

  await page.goto('/')
  await loadCaptured
  const newProse = page.getByTestId('new-prose')
  await expect(newProse).toBeVisible()
  await expect(newProse).toBeDisabled()

  releaseLoad()
  await expect(newProse).toBeEnabled()
})

test('canvas write progress is exposed as a live status', async ({ page }) => {
  await page.goto('/')
  const status = page.getByRole('status', { name: /canvas/i })
  await expect(status).toBeVisible()
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status).toHaveAttribute('data-write-status', /loading|idle|unsaved|saving|syncing/)
})

test('a failed outgoing flush keeps the current project mounted', async ({ page, request }) => {
  const projects = await (await request.get(`${BASE}/projects`)).json() as Array<{
    id: string
    name: string
  }>
  const current = projects.find((project) => project.id === projectId)
  if (!current) throw new Error('reset project missing')
  const nextName = `Switch target ${Date.now()}`
  await request.post(`${BASE}/projects`, { data: { name: nextName } })

  await page.goto('/')
  await expect(page.getByTestId('project-switcher')).toContainText(current.name)
  let observeSaveFailure!: () => void
  const saveFailed = new Promise<void>((resolve) => {
    observeSaveFailure = resolve
  })
  await page.route(
    (url) => url.pathname === `/projects/${projectId}/canvas`,
    async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 500, body: 'forced save failure' })
        observeSaveFailure()
        return
      }
      await route.continue()
    },
  )

  await page.getByTestId('new-prose').click()
  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: nextName }).click()
  await saveFailed
  await page.waitForTimeout(500)

  await expect(page.getByTestId('project-switcher')).toContainText(current.name)
  await expect(page.locator('.elves-card--prose')).toHaveCount(1)
})

test('a same-tick edit is admitted before a successful project switch', async ({ page, request }) => {
  const projects = await (await request.get(`${BASE}/projects`)).json() as Array<{
    id: string
    name: string
  }>
  const current = projects.find((project) => project.id === projectId)
  if (!current) throw new Error('reset project missing')
  const nextName = `Same tick target ${Date.now()}`
  await request.post(`${BASE}/projects`, { data: { name: nextName } })

  await page.goto('/')
  await page.getByTestId('new-prose').click()
  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: nextName }).click()
  await expect(page.getByTestId('project-switcher')).toContainText(nextName)

  await page.getByTestId('project-switcher').click()
  await page.getByRole('menuitemradio', { name: current.name }).click()
  await expect(page.locator('.elves-card--prose')).toHaveCount(1)
})

test('a transient initialization failure can be retried', async ({ page }) => {
  let canvasGets = 0
  await page.route(
    (url) => url.pathname.endsWith('/canvas'),
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue()
      canvasGets += 1
      if (canvasGets === 1) {
        await route.fulfill({ status: 500, body: 'transient load failure' })
        return
      }
      await route.continue()
    },
  )

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Retry canvas' })).toBeVisible()
  await page.getByRole('button', { name: 'Retry canvas' }).click()
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  expect(canvasGets).toBe(2)
})

test('ambiguous rename locks mutations and offers same-name recovery', async ({ page, request }) => {
  const projects = await (await request.get(`${BASE}/projects`)).json() as Array<{
    id: string
    name: string
    createdAt: string
  }>
  const current = projects.find((project) => project.id === projectId)
  if (!current) throw new Error('reset project missing')
  const renamed = { ...current, name: `Recovered ${Date.now()}` }
  let projectLists = 0

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill('read-only during ambiguity')
  await page.keyboard.press('Escape')
  await page.route(`**/projects/${projectId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await route.fulfill({ status: 503, body: 'rename response lost' })
      return
    }
    await route.continue()
  })
  await page.route((url) => url.pathname === '/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    projectLists += 1
    if (projectLists === 1) {
      await route.fulfill({ status: 500, body: 'observation failed' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([renamed]) })
  })

  page.once('dialog', (dialog) => dialog.accept(renamed.name))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-rename').click()

  await expect(page.getByTestId('new-prose')).toBeDisabled()
  const card = page.locator('.elves-card--prose').first()
  const bounds = await card.boundingBox()
  if (!bounds) throw new Error('prose card not in DOM')
  await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await expect(page.locator('.elves-card__editor')).toHaveCount(0)
  const retry = page.getByRole('button', { name: `Retry rename to ${renamed.name}` })
  await expect(retry).toBeVisible()
  await retry.click()
  await expect.poll(() => projectLists).toBeGreaterThanOrEqual(2)
  await expect(page.getByTestId('project-switcher')).toContainText(renamed.name)
  await expect(page.getByTestId('new-prose')).toBeEnabled()
})

test('a committed rename drain failure still adopts identity without remounting', async ({ page }) => {
  const renamedName = `Committed drain ${Date.now()}`
  let renamedId: string | null = null
  let renameCommitted = false
  let renamedCanvasGets = 0

  await page.route((url) => url.pathname.endsWith('/canvas'), async (route) => {
    if (route.request().method() === 'GET' && renameCommitted &&
      renamedId && new URL(route.request().url()).pathname === `/projects/${renamedId}/canvas`) {
      renamedCanvasGets += 1
      await route.fulfill({ status: 500, body: 'forced post-rename sync failure' })
      return
    }
    await route.continue()
  })
  await page.route(`**/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    const response = await route.fetch()
    const updated = await response.json() as { id: string }
    renamedId = updated.id
    renameCommitted = true
    await route.fulfill({ response })
  })

  await page.goto('/')
  const canvas = page.locator('.tl-canvas')
  await expect(canvas).toBeVisible()
  await canvas.evaluate((element) => element.setAttribute('data-mount-marker', 'original'))

  page.once('dialog', (dialog) => dialog.accept(renamedName))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-rename').click()

  await expect(page.getByTestId('project-switcher')).toContainText(renamedName)
  await expect(canvas).toHaveAttribute('data-mount-marker', 'original')
  await expect(page.locator('.elves-canvas-write-status')).toHaveAttribute('data-write-status', 'error')
  expect(renamedCanvasGets).toBe(1)
})
