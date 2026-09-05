import { expect, test } from '@playwright/test'
import { BASE, resetProject } from './helpers'

let projectId: string

test.beforeEach(async ({ request }) => {
  projectId = await resetProject(request)
})

test('reload before the debounce restores the committed local journal', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  let saveAttempts = 0
  await page.route((url) => url.pathname === `/projects/${projectId}/canvas`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    saveAttempts += 1
    if (saveAttempts === 1) return route.abort('connectionreset')
    await route.continue()
  })

  await page.getByTestId('new-prose').click()
  const text = `Journal survives ${Date.now()}`
  await page.locator('.elves-card__editor').fill(text)
  await expect.poll(() => journalContains(page, text)).toBe(true)
  expect(saveAttempts).toBe(0)

  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect(page.locator('.elves-card--prose')).toContainText(text)
  await page.unrouteAll()
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect(page.locator('.elves-card--prose')).toContainText(text)
  await expect.poll(async () => {
    const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
    return JSON.stringify(snapshot).includes(text)
  }).toBe(true)
  await expect.poll(() => journalCount(page)).toBe(0)
})

test('an offline reload keeps the journal until the API returns', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('new-prose').click()
  const text = `Offline journal ${Date.now()}`
  await page.locator('.elves-card__editor').fill(text)
  await expect.poll(() => journalContains(page, text)).toBe(true)

  await page.route('**/projects**', (route) => route.abort('connectionreset'))
  page.once('dialog', (dialog) => dialog.accept())
  await page.reload()
  await expect.poll(() => journalCount(page)).toBe(1)

  await page.unroute('**/projects**')
  await page.reload()
  await expect(page.locator('.elves-card--prose')).toContainText(text)
  await expect.poll(async () => {
    const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
    return JSON.stringify(snapshot).includes(text)
  }).toBe(true)
  await expect.poll(() => journalCount(page)).toBe(0)
})

test('a new page recovers an orphaned journal after the original page closes', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.route((url) => url.pathname === `/projects/${projectId}/canvas`, async (route) => {
    if (route.request().method() === 'POST') return route.abort('connectionreset')
    await route.continue()
  })
  await page.getByTestId('new-prose').click()
  const text = `Closed tab journal ${Date.now()}`
  await page.locator('.elves-card__editor').fill(text)
  await expect.poll(() => journalContains(page, text)).toBe(true)

  page.once('dialog', (dialog) => dialog.accept())
  await page.close({ runBeforeUnload: true })
  const reopened = await page.context().newPage()
  await reopened.goto('/')
  await expect(reopened.locator('.elves-card--prose')).toContainText(text)
  await expect.poll(async () => {
    const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
    return JSON.stringify(snapshot).includes(text)
  }).toBe(true)
  await expect.poll(() => journalCount(reopened)).toBe(0)
})

test('a duplicated tab rotates a cloned recovery session identity', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  const originalSession = await page.evaluate(() => sessionStorage.getItem('elves:canvas-recovery-session-v1'))
  if (!originalSession) throw new Error('original recovery session identity missing')
  await expect.poll(() => page.evaluate(async (sessionId) => {
    const snapshot = await navigator.locks.query()
    return snapshot.held?.some((lock) => lock.name === `elves:canvas-recovery-session-v1:${sessionId}`)
  }, originalSession)).toBe(true)

  await page.context().addInitScript((sessionId) => {
    sessionStorage.setItem('elves:canvas-recovery-session-v1', sessionId)
  }, originalSession)
  const duplicate = await page.context().newPage()
  await duplicate.goto('/')
  await expect(duplicate.getByTestId('new-prose')).toBeEnabled()
  const duplicateSession = await duplicate.evaluate(() => sessionStorage.getItem('elves:canvas-recovery-session-v1'))

  expect(duplicateSession).not.toBe(originalSession)
})

test('a same-record conflict asks before discarding or saving local recovery', async ({ page, request }) => {
  await page.goto('/')
  await expect(page.getByTestId('new-prose')).toBeEnabled()
  await page.getByTestId('new-prose').click()
  await page.locator('.elves-card__editor').fill('base wording')
  await page.keyboard.press('Escape')
  await expect.poll(async () => {
    const snapshot = await (await request.get(`${BASE}/projects/${projectId}/canvas`)).json()
    return JSON.stringify(snapshot).includes('base wording')
  }).toBe(true)

  const authoritative = await (await request.get(`${BASE}/projects/${projectId}/canvas?protocol=2`)).json() as any
  const projects = await (await request.get(`${BASE}/projects`)).json() as Array<{ id: string; storageId: string }>
  const storageId = projects.find((project) => project.id === projectId)?.storageId
  if (!storageId) throw new Error('project storage identity missing')
  const sessionId = await page.evaluate(() => sessionStorage.getItem('elves:canvas-recovery-session-v1'))
  if (!sessionId) throw new Error('browser recovery session identity missing')
  const baseDocument = documentRecords(authoritative.snapshot)
  const localDocument = structuredClone(baseDocument)
  const remoteSnapshot = structuredClone(authoritative.snapshot)
  const localCard = Object.values(localDocument).find((record: any) => record.typeName === 'shape' && record.type === 'card') as any
  const remoteCard = Object.values(remoteSnapshot.document.store).find((record: any) => record.typeName === 'shape' && record.type === 'card') as any
  localCard.props.text = 'local wording'
  remoteCard.props.text = 'remote wording'
  const remoteSave = await request.post(`${BASE}/projects/${projectId}/canvas?protocol=2`, {
    headers: { 'x-elves-canvas-revision': String(authoritative.revision) },
    data: remoteSnapshot,
  })
  expect(remoteSave.status()).toBe(200)
  await putJournal(page, {
    key: `http://localhost:5199\u0000${storageId}\u0000${sessionId}`,
    format: 1,
    serverOrigin: 'http://localhost:5199',
    storageId,
    projectId,
    sessionId,
    generation: 1,
    createdAt: '2026-09-05T12:00:00.000Z',
    updatedAt: '2026-09-05T12:00:01.000Z',
    baseRevision: authoritative.revision,
    baseEpoch: authoritative.nextChangeSetToken.epoch,
    baseDocument,
    localDocument,
    localSnapshot: authoritative.snapshot,
  })

  await page.reload()
  await expect(page.getByRole('status', { name: /recovered changes conflict/i })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Recover local changes' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Discard local changes' })).toBeVisible()
  await expect(page.locator('.elves-card--prose')).toContainText('remote wording')
  await page.getByRole('button', { name: 'Discard local changes' }).click()
  await expect(page.getByRole('button', { name: 'Recover local changes' })).toHaveCount(0)
  await expect.poll(() => journalCount(page)).toBe(0)
})

async function journalCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open('elves-canvas-recovery-v1', 1)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('entries')) {
        request.result.createObjectStore('entries', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      const count = db.transaction('entries', 'readonly').objectStore('entries').count()
      count.onerror = () => reject(count.error)
      count.onsuccess = () => {
        db.close()
        resolve(count.result)
      }
    }
  }))
}

async function journalContains(page: import('@playwright/test').Page, text: string): Promise<boolean> {
  return page.evaluate((expected) => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('elves-canvas-recovery-v1', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('entries', 'readonly').objectStore('entries').getAll()
      get.onerror = () => reject(get.error)
      get.onsuccess = () => {
        db.close()
        resolve(JSON.stringify(get.result).includes(expected))
      }
    }
  }), text)
}

function documentRecords(snapshot: any): Record<string, any> {
  return Object.fromEntries(Object.entries(snapshot.document.store).filter(([, record]: [string, any]) =>
    ['asset', 'binding', 'document', 'page', 'shape'].includes(record.typeName)))
}

async function putJournal(page: import('@playwright/test').Page, entry: unknown): Promise<void> {
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('elves-canvas-recovery-v1', 1)
    request.onerror = () => reject(request.error)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('entries')) {
        request.result.createObjectStore('entries', { keyPath: 'key' })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      const transaction = db.transaction('entries', 'readwrite')
      transaction.objectStore('entries').put(value)
      transaction.onerror = () => reject(transaction.error)
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
    }
  }), entry)
}
