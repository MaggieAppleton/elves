import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import type { AgentEvent, AgentRunHandle } from '../../src/client/agent'

const runAgentMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/client/agent', () => ({ runAgent: runAgentMock }))

import { AgentBox } from '../../src/components/AgentBox'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  runAgentMock.mockReset()
})

test('unmount cancels the active run and disposes its callbacks without reacting to rerenders', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })

  let emit!: (event: AgentEvent) => void
  let disposed = false
  let deliveredEvents = 0
  const dispose = vi.fn(() => { disposed = true })
  const requestCancel = vi.fn(async () => {})
  const handle: AgentRunHandle = {
    runId: 'run-1',
    suppressCallbacks: vi.fn(),
    dispose,
    requestCancel,
    done: new Promise<void>(() => {}),
  }
  runAgentMock.mockImplementation((_input, onEvent: (event: AgentEvent) => void) => {
    emit = (event) => {
      if (disposed) return
      deliveredEvents += 1
      onEvent(event)
    }
    return handle
  })

  const onClose = vi.fn()
  const props = { open: true, projectId: 'project-1', selectedCount: 0, onClose }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(AgentBox, props))
  })
  await act(async () => {
    renderer.root.findByProps({ 'data-testid': 'agent-input' }).props.onChange({
      target: { value: 'Review the canvas' },
    })
  })
  await act(async () => {
    renderer.root.findByProps({ 'data-testid': 'agent-send' }).props.onClick()
  })

  await act(async () => {
    renderer.update(createElement(AgentBox, { ...props, selectedCount: 1 }))
  })
  expect(dispose).not.toHaveBeenCalled()
  expect(requestCancel).not.toHaveBeenCalled()

  await act(async () => {
    renderer.unmount()
  })
  emit({ type: 'text', text: 'stale reply' })

  expect(dispose).toHaveBeenCalledOnce()
  expect(requestCancel).toHaveBeenCalledOnce()
  expect(deliveredEvents).toBe(0)
})
