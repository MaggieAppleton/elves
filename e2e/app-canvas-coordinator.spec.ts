import { test, expect } from '@playwright/test'
import { readSelectionTool } from '../mcp/tools'
import { BASE, resetProject, serverCardIds } from './helpers'

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
  await expect(status).toContainText(/canvas/i)
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status).toHaveAttribute('data-write-status', /loading|idle|unsaved|saving|syncing/)
  await expect(page.locator('.elves-realtime-status')).toHaveAttribute(
    'aria-label',
    /live agent updates/i,
  )
})

test('an active agent run holds project identity until the run settles', async ({ page }) => {
  let releaseRun!: () => void
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })
  let captureRun!: () => void
  const runCaptured = new Promise<void>((resolve) => {
    captureRun = resolve
  })
  await page.route('**/agent/prepare', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }),
  )
  await page.route('**/agent/run', async (route) => {
    captureRun()
    await runGate
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'done', reply: 'done' })}\n\n`,
    })
  })

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.keyboard.press('/')
  await page.getByTestId('agent-input').fill('hold this project')
  await page.getByTestId('agent-send').click()
  await runCaptured

  await expect(page.getByTestId('project-switcher')).toBeDisabled()
  releaseRun()
  await expect(page.getByTestId('project-switcher')).toBeEnabled()
})

test('overlapping review requests keep project transitions locked until both settle', async ({ page }) => {
  const releases: Array<() => void> = []
  let requestCount = 0
  let responseCount = 0
  await page.route(`**/projects/${projectId}/reviews`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    requestCount += 1
    const requestNumber = requestCount
    const { personality } = route.request().postDataJSON() as { personality: string }
    await new Promise<void>((resolve) => releases.push(resolve))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        review: {
          id: (route.request().postDataJSON() as { reviewId: string }).reviewId,
          personality,
          status: 'dismissed',
          focus: null,
          requestedAt: `2026-07-14T12:00:0${requestNumber}.000Z`,
          agent: null,
          startedAt: null,
          completedAt: null,
          verdict: null,
          commentCount: 0,
          error: null,
        },
      }),
    })
    responseCount += 1
  })

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('review-button').click()
  await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid^="review-summon-"]'))
    buttons[0]?.click()
    buttons[1]?.click()
  })
  await expect.poll(() => requestCount).toBe(2)
  await expect(page.getByTestId('project-switcher')).toBeDisabled()

  releases[0]()
  await expect.poll(() => responseCount).toBe(1)
  await expect(page.getByTestId('project-switcher')).toBeDisabled()
  releases[1]()
  await expect.poll(() => responseCount).toBe(2)
  await expect(page.getByTestId('project-switcher')).toBeEnabled()
})

test('summon and dismiss stay locked through lost responses and failed refresh', async ({ page }) => {
  const review = {
    id: '',
    personality: 'architect',
    status: 'pending',
    focus: null,
    requestedAt: '2026-07-14T12:00:00.000Z',
    agent: null,
    startedAt: null,
    completedAt: null,
    verdict: null,
    commentCount: 0,
    error: null,
  }
  let mutationAccepted = false
  const summonBodies: any[] = []
  const dismissBodies: any[] = []
  await page.route(`**/projects/${projectId}/reviews`, async (route) => {
    if (route.request().method() === 'POST') {
      summonBodies.push(route.request().postDataJSON())
      mutationAccepted = true
      review.id = summonBodies[0].reviewId
      if (summonBodies.length === 1) return route.abort('connectionreset')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ review }),
      })
    }
    if (mutationAccepted) return route.fulfill({ status: 500, body: 'refresh unavailable' })
    return route.continue()
  })
  await page.route(`**/projects/${projectId}/reviews/*/status`, async (route) => {
    dismissBodies.push(route.request().postDataJSON())
    if (dismissBodies.length === 1) return route.abort('connectionreset')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ review: { ...review, status: 'dismissed' } }),
    })
  })

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('review-button').click()
  await page.getByTestId('review-summon-architect').click()

  const pass = page.getByTestId('review-pass-architect')
  await expect.poll(() => summonBodies.length).toBe(1)
  await expect(page.getByTestId('project-switcher')).toBeDisabled()
  await expect(pass).toHaveAttribute('data-status', 'pending')
  expect(summonBodies[1]).toEqual(summonBodies[0])
  await expect(page.getByTestId('project-switcher')).toBeDisabled()

  await page.getByTestId('review-dismiss-architect').click()
  await expect.poll(() => dismissBodies.length).toBe(1)
  await expect(page.getByTestId('project-switcher')).toBeDisabled()
  await expect(pass).toHaveCount(0)
  expect(dismissBodies[1]).toEqual(dismissBodies[0])
  await expect(page.getByTestId('project-switcher')).toBeEnabled()
})

test('retry stays active through a lost response and failed refresh', async ({ page }) => {
  const review = {
    id: 'rev-retry',
    personality: 'trimmer',
    status: 'failed',
    focus: null,
    requestedAt: '2026-07-14T12:00:00.000Z',
    agent: null,
    startedAt: null,
    completedAt: null,
    verdict: null,
    commentCount: 0,
    error: 'agent stopped',
  }
  let retryAccepted = false
  const retryBodies: any[] = []
  await page.route(`**/projects/${projectId}/reviews`, async (route) => {
    if (retryAccepted) return route.fulfill({ status: 500, body: 'refresh unavailable' })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reviews: [review] }),
    })
  })
  await page.route(`**/projects/${projectId}/reviews/${review.id}/run`, async (route) => {
    retryBodies.push(route.request().postDataJSON())
    retryAccepted = true
    if (retryBodies.length === 1) return route.abort('connectionreset')
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({
        review: { ...review, status: 'pending', error: null, attemptId: retryBodies[0].attemptId },
      }),
    })
  })

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('review-button').click()
  await page.getByTestId('review-retry-trimmer').click()

  await expect.poll(() => retryBodies.length).toBe(1)
  await expect(page.getByTestId('project-switcher')).toBeDisabled()
  await expect(page.getByTestId('review-pass-trimmer')).toHaveAttribute('data-status', 'pending')
  expect(retryBodies[1]).toEqual(retryBodies[0])
  await expect(page.getByTestId('project-switcher')).toBeDisabled()
})

test('ambiguous rename recovery stays reachable at 320px', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  const projects = await (await request.get(`${BASE}/projects`)).json() as Array<{
    id: string
    name: string
    createdAt: string
  }>
  const current = projects.find((project) => project.id === projectId)
  if (!current) throw new Error('reset project missing')
  const renamed = { ...current, name: `Narrow recovered ${Date.now()}` }
  let projectLists = 0

  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.route(`**/projects/${projectId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue()
    await route.fulfill({ status: 503, body: 'rename response lost' })
  })
  await page.route((url) => url.pathname === '/projects', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    projectLists += 1
    if (projectLists === 1) return route.fulfill({ status: 500, body: 'observation failed' })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([renamed]),
    })
  })

  page.once('dialog', (dialog) => dialog.accept(renamed.name))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-rename').click()
  const status = page.locator('.elves-canvas-write-status')
  const retry = page.getByRole('button', { name: `Retry rename to ${renamed.name}` })
  await expect(retry).toBeVisible()
  for (const locator of [status, retry]) {
    const bounds = await locator.boundingBox()
    if (!bounds) throw new Error('status control missing')
    expect(bounds.x).toBeGreaterThanOrEqual(0)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  }

  await retry.click()
  await expect(page.getByTestId('project-switcher')).toContainText(renamed.name)
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
  await expect(page.getByTestId('new-prose')).toBeEnabled()
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
  await expect(page.locator('.elves-card--prose').first()).toBeVisible()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
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
  await page.getByTestId('draft-open').click()
  await expect(page.getByTestId('draft-para')).toBeVisible()
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
  await page.getByTestId('draft-para').dispatchEvent('click')
  await expect(page.getByTestId('draft-editor')).toHaveCount(0)
  await page.keyboard.press('/')
  await expect(page.getByRole('dialog', { name: 'Ask an agent' })).toHaveCount(0)
  await expect(page.getByTestId('review-button')).toBeDisabled()
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
  let observeRefresh!: () => void
  const refreshStarted = new Promise<void>((resolve) => {
    observeRefresh = resolve
  })

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
  await page.route((url) => url.pathname === '/projects', async (route) => {
    if (!renameCommitted || route.request().method() !== 'GET') return route.continue()
    observeRefresh()
    await new Promise<void>(() => {})
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
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await refreshStarted
  expect(renamedCanvasGets).toBe(1)
})

test('rename republishes the unchanged selection under the committed identity', async ({ page, request }) => {
  const renamedName = `Selection identity ${Date.now()}`
  const renamedId = renamedName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  await page.goto('/')
  await page.getByTestId('new-prose').click()
  await expect.poll(async () => (await serverCardIds(request, projectId)).length).toBe(1)
  const [cardId] = await serverCardIds(request, projectId)
  await expect.poll(async () => (await readSelectionTool(BASE)).selection.map((shape) => shape.id))
    .toEqual([cardId])
  await page.keyboard.press('Escape')

  page.once('dialog', (dialog) => dialog.accept(renamedName))
  await page.getByTestId('project-switcher').click()
  await page.getByTestId('project-rename').click()
  await expect(page.getByTestId('project-switcher')).toContainText(renamedName)

  await expect.poll(async () => {
    const selection = await readSelectionTool(BASE)
    return { project: selection.project, ids: selection.selection.map((shape) => shape.id) }
  }).toEqual({ project: renamedId, ids: [cardId] })
})
