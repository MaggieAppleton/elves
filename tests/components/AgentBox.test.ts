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

test('a follow-up preserves the transcript and sends the completed prior turn as context', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })

  const callbacks: Array<(event: AgentEvent) => void> = []
  runAgentMock.mockImplementation((_input, onEvent: (event: AgentEvent) => void) => {
    callbacks.push(onEvent)
    return {
      runId: `run-${callbacks.length}`,
      suppressCallbacks: vi.fn(),
      dispose: vi.fn(),
      requestCancel: vi.fn(async () => {}),
      done: Promise.resolve(),
    } satisfies AgentRunHandle
  })

  const props = { open: true, projectId: 'project-1', selectedCount: 0, onClose: vi.fn() }
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(AgentBox, props))
  })

  const send = async (text: string) => {
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'agent-input' }).props.onChange({ target: { value: text } })
    })
    await act(async () => {
      renderer.root.findByProps({ 'data-testid': 'agent-send' }).props.onClick()
    })
  }

  await send('Find quotes about this card')
  await act(async () => {
    callbacks[0]({ type: 'text', text: 'Searching for quotes.' })
    callbacks[0]({ type: 'text', text: 'Here are three quotes.' })
    callbacks[0]({ type: 'done', reply: 'Here are three quotes.' })
  })

  await send('Add those below the card')
  await act(async () => {
    callbacks[1]({ type: 'done', reply: 'Here are three quotes.' })
  })

  const transcript = renderer.root.findByProps({ 'data-testid': 'agent-transcript' })
  const transcriptText = transcript.findAllByType('p').flatMap((line) => line.children).join('')
  expect(transcriptText).toContain('Find quotes about this card')
  expect(transcriptText).toContain('Here are three quotes.')
  expect(transcriptText).toContain('Add those below the card')
  expect(renderer.root.findAll((node) =>
    node.props.className === 'elves-agentbox__text' && node.children.join('') === 'Here are three quotes.',
  )).toHaveLength(2)
  expect(runAgentMock).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: [
        { role: 'user', text: 'Find quotes about this card' },
        { role: 'assistant', text: 'Here are three quotes.' },
      ],
    }),
    expect.any(Function),
  )
})
