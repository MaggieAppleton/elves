// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { react } from 'tldraw'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  assetUrl,
  setAssetProject,
  uploadAsset,
  useAssetProject,
} from '../../src/client/assets'

const stops: Array<() => void> = []

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  setAssetProject(null)
})

afterEach(() => {
  while (stops.length) stops.pop()?.()
  setAssetProject(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test('asset URLs react to committed project changes and clear without stale values', () => {
  const urls: string[] = []
  stops.push(react('test asset URL consumer', () => {
    urls.push(assetUrl('image.png'))
  }))

  setAssetProject('alpha project')
  setAssetProject('alpha project')
  setAssetProject('beta')
  setAssetProject(null)

  expect(urls).toEqual([
    '',
    'http://localhost:5199/projects/alpha%20project/assets/image.png',
    'http://localhost:5199/projects/beta/assets/image.png',
    '',
  ])
})

test('the project binding is render-pure and synchronizes only after commit without looping', () => {
  setAssetProject('old')
  const urlsSeenDuringRender: string[] = []
  let renders = 0
  function Binding({ projectId }: { projectId: string | null }) {
    useAssetProject(projectId)
    renders += 1
    urlsSeenDuringRender.push(assetUrl('image.png'))
    return null
  }

  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(createElement(Binding, { projectId: 'new' }))
  })
  expect(urlsSeenDuringRender).toEqual([
    'http://localhost:5199/projects/old/assets/image.png',
  ])
  expect(assetUrl('image.png')).toBe(
    'http://localhost:5199/projects/new/assets/image.png',
  )

  act(() => {
    root.render(createElement(Binding, { projectId: null }))
  })
  expect(renders).toBe(2)
  expect(assetUrl('image.png')).toBe('')

  act(() => { root.unmount() })
})

test('StrictMode replay and remount leave the committed project active, then clear on unmount', () => {
  setAssetProject('old')
  const committedUrls: string[] = []
  stops.push(react('test StrictMode asset commits', () => {
    committedUrls.push(assetUrl('image.png'))
  }))
  const urlsSeenDuringRender: string[] = []
  let renders = 0
  function Binding({ projectId }: { projectId: string }) {
    useAssetProject(projectId)
    renders += 1
    urlsSeenDuringRender.push(assetUrl('image.png'))
    return null
  }
  const tree = (projectId: string) => createElement(
    StrictMode,
    null,
    createElement(Binding, { projectId }),
  )

  const container = document.createElement('div')
  let root = createRoot(container)
  act(() => { root.render(tree('alpha')) })
  expect(renders).toBe(2)
  expect(urlsSeenDuringRender).toEqual([
    'http://localhost:5199/projects/old/assets/image.png',
    'http://localhost:5199/projects/old/assets/image.png',
  ])
  expect(committedUrls.slice(0, 4)).toEqual([
    'http://localhost:5199/projects/old/assets/image.png',
    'http://localhost:5199/projects/alpha/assets/image.png',
    '',
    'http://localhost:5199/projects/alpha/assets/image.png',
  ])
  expect(assetUrl('image.png')).toContain('/projects/alpha/assets/image.png')
  act(() => { root.render(tree('beta')) })
  expect(renders).toBe(4)
  expect(assetUrl('image.png')).toContain('/projects/beta/assets/image.png')
  act(() => { root.unmount() })
  expect(assetUrl('image.png')).toBe('')

  root = createRoot(container)
  act(() => { root.render(tree('beta')) })
  expect(assetUrl('image.png')).toContain('/projects/beta/assets/image.png')
  act(() => { root.unmount() })
  expect(assetUrl('image.png')).toBe('')
})

test('an older binding cleanup cannot clear a newer overlapping owner', () => {
  function Binding({ projectId }: { projectId: string }) {
    useAssetProject(projectId)
    return null
  }
  const oldRoot = createRoot(document.createElement('div'))
  const newRoot = createRoot(document.createElement('div'))

  act(() => { oldRoot.render(createElement(Binding, { projectId: 'old' })) })
  act(() => { newRoot.render(createElement(Binding, { projectId: 'new' })) })
  expect(assetUrl('image.png')).toContain('/projects/new/assets/image.png')

  act(() => { oldRoot.unmount() })
  expect(assetUrl('image.png')).toContain('/projects/new/assets/image.png')
  act(() => { newRoot.unmount() })
  expect(assetUrl('image.png')).toBe('')
})

test('uploadAsset keeps its explicit project-scoped API', async () => {
  const fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ assetId: 'asset.png' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ))
  vi.stubGlobal('fetch', fetchMock)
  const file = new File(['pixels'], 'asset.png', { type: 'image/png' })

  await expect(uploadAsset('alpha project', file)).resolves.toBe('asset.png')
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:5199/projects/alpha%20project/assets',
    {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: file,
    },
  )
})
