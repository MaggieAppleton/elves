import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AnnotationPin, AnnotationThread } from '../../src/components/AnnotationThread'
import {
  annotationHoverTarget, clearAnnotationPresentations, setAnnotationThreadPresentation,
  subscribeAnnotationReply, subscribeAnnotationRetry,
} from '../../src/client/annotationSelection'
import { foregroundThreadProps } from '../../src/components/AnnotationPopoverLayer'
import { annotationPin } from '../../src/model/annotationPins'
const openComposer = (tree: ReactTestRenderer, index = 0) => {
  act(() => tree.root
    .findAllByProps({ className: 'elves-annotation-thread__reply-trigger' })[index]
    .props.onClick())
}

test('preview has no reply, retry, resolve, or close controls', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: 'structure', text: 'Initial finding', resolved: false, author: 'claude',
      messages: [
        { id: 'm1', author: 'claude', text: 'Initial finding', createdAt: '2026-08-30T09:00:00Z' },
        { id: 'm2', author: 'user', text: 'What would fix it?', createdAt: '2026-08-30T09:01:00Z' },
      ],
    },
    mode: 'preview',
    error: 'The reply stopped.',
    onReply: vi.fn(),
    onRetry: vi.fn(),
    onResolve: vi.fn(),
    onClose: vi.fn(),
  }))

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findAllByType('button')).toHaveLength(0)
})

test('open mode exposes reply, retry, resolve, and close actions', () => {
  const onClose = vi.fn()
  const onResolve = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onClose, onResolve, onReply: vi.fn(),
    error: 'The reply stopped.', onRetry: vi.fn(),
  }))

  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  const alert = tree.root.findByProps({ className: 'elves-annotation-thread__error' })
  expect(alert.props.role).toBe('alert')
  expect(alert.findAllByType('svg')).toHaveLength(1)
  expect(alert.findByProps({ className: 'elves-annotation-thread__error-message' }).children.join(''))
    .toContain('The reply stopped.')
  expect(alert.findByProps({ className: 'elves-annotation-thread__retry' })).toBeTruthy()
  const reply = tree.root.findByProps({ className: 'elves-annotation-thread__reply-trigger' })
  expect(reply.props['aria-label']).toBe('Reply to annotation')
  expect(reply.findAllByType('svg')).toHaveLength(1)
  expect(reply.children.filter((child) => typeof child === 'string' && child.trim() !== '')).toHaveLength(0)
  act(() => reply.props.onClick())
  expect(tree.root.findByType('textarea').props.autoFocus).toBe(true)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props['aria-label'])
    .toBe('Close annotation thread')
  const resolve = tree.root.findByProps({ className: 'elves-annotation-thread__resolve' })
  expect(resolve.props['aria-label']).toBe('Resolve Comment comment')
  const retry = tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))
  expect(retry).toBeTruthy()
  expect(retry!.props.className).toBe('elves-annotation-thread__retry')
  resolve.props.onClick()
  expect(onResolve).toHaveBeenCalledOnce()
  tree.root.findByProps({ className: 'elves-annotation-thread__close' }).props.onClick()
  expect(onClose).toHaveBeenCalledOnce()
})

test('thread header shows its typed icon and actions while messages retain author provenance', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: 'needs-evidence', text: 'Opening note', resolved: false, author: 'claude',
      messages: [
        { id: 'claude-1', author: 'claude', text: 'Opening note', createdAt: '2026-08-30T09:00:00Z' },
        { id: 'user-1', author: 'user', text: 'A reply', createdAt: '2026-08-30T09:01:00Z' },
      ],
    },
    mode: 'open', onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn(),
  }))

  openComposer(tree)

  const header = tree.root.findByProps({ className: 'elves-annotation-thread__header' })
  const type = header.findByProps({ className: 'elves-annotation-thread__type' })
  expect(type.props['data-type']).toBe('needs-evidence')
  expect(type.findAllByType('svg')).toHaveLength(1)
  expect(type.children.filter((child) => typeof child === 'string').join('')).toBe('Needs evidence')
  expect(header.findAllByProps({ className: 'elves-annotation-thread__message-author' })).toHaveLength(0)
  expect(header.findAll((node) => node.children.some((child) => typeof child === 'string' && child.trim() === 'Claude')))
    .toHaveLength(0)

  const actions = header.findByProps({ className: 'elves-annotation-thread__actions' })
  const directButtons = actions.children.filter((child) => typeof child !== 'string')
  expect(directButtons.map((button) => button.props.className)).toEqual([
    'elves-annotation-thread__resolve', 'elves-annotation-thread__close',
  ])
  const resolve = directButtons[0]
  const close = directButtons[1]
  expect(resolve.findAllByType('svg')).toHaveLength(1)
  expect(resolve.children.filter((child) => typeof child === 'string').join('')).toBe('Resolve')
  expect(close.findAllByType('svg')).toHaveLength(1)
  expect(close.children.filter((child) => typeof child === 'string').join('')).toBe('')

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message-author' }).map((node) => node.children.join('')))
    .toEqual(['Claude', 'You'])
  const send = tree.root.findByProps({ className: 'elves-annotation-thread__send' })
  expect(send.findAllByType('svg')).toHaveLength(1)
  expect(send.children.filter((child) => typeof child === 'string').join('')).toBe('')
  expect(send.findAll((node) => node.children.some((child) => typeof child === 'string' && child.trim() !== '')))
    .toHaveLength(0)
  expect(send.props['aria-label']).toBe('Send reply')
  expect(close.props['aria-label']).toBe('Close annotation thread')
})

test('reply composer has no resize grip and autosizes from its draft content', () => {
  const onReply = vi.fn()
  const input = {
    value: '',
    style: {} as CSSStyleDeclaration,
    get scrollHeight() {
      return input.value ? 104 : 76
    },
  }
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onReply,
  }), {
    createNodeMock: (element) => element.type === 'textarea' ? input : null,
  })

  openComposer(tree)
  expect(tree.root.findAllByProps({
    className: 'elves-annotation-thread__reply-resize',
  })).toHaveLength(0)
  const textarea = tree.root.findByType('textarea')
  const reply = tree.root.findByProps({ className: 'elves-annotation-thread__reply' })
  expect(reply.findAllByProps({ role: 'separator' })).toHaveLength(0)
  expect(textarea.props.style).not.toHaveProperty('minHeight')
  expect(input.style.height).toBe('76px')
  input.value = 'A considered reply'
  act(() => textarea.props.onChange({ target: input }))
  expect(input.style.height).toBe('104px')
  input.value = ''
  act(() => textarea.props.onChange({ target: input }))
  expect(input.style.height).toBe('76px')
  input.value = 'A considered reply'
  act(() => textarea.props.onChange({ target: input }))
  expect(input.style.height).toBe('104px')

  act(() => reply.props.onSubmit({ preventDefault: vi.fn() }))
  expect(onReply).toHaveBeenCalledWith('A considered reply')
  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
})

test('thread renders durable replies and only disables its own send control while running', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: {
      id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude',
      messages: [
        { id: 'claude-1', author: 'claude', text: 'Needs evidence', createdAt: '2026-08-29T11:00:00.000Z' },
        { id: 'user-1', author: 'user', text: 'Which source?', createdAt: '2026-08-29T12:00:00.000Z' },
      ],
    },
    mode: 'open',
    running: true,
    onResolve: vi.fn(),
    onReply: vi.fn(),
  }))

  expect(tree.root.findAllByType('textarea')).toHaveLength(0)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__reply-trigger' }).props.disabled).toBe(true)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message' })).toHaveLength(2)
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__resolve' }).props.disabled).toBe(false)
})

test('a streaming Claude reply retains its author provenance', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open',
    streamingText: 'I am checking the source now.',
  }))

  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__message-author' }).map((node) => node.children.join('')))
    .toEqual(['Claude', 'Claude'])
})

test('simultaneous threads keep reply state isolated', () => {
  const tree = create(createElement('div', {},
    createElement(AnnotationThread, {
      comment: { id: 'a', type: null, text: 'Finding', resolved: false, author: 'claude' },
      mode: 'open', running: false, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn(),
    }),
    createElement(AnnotationThread, {
      comment: { id: 'b', type: null, text: 'Finding', resolved: false, author: 'claude' },
      mode: 'open', running: false, onReply: vi.fn(), onResolve: vi.fn(), onClose: vi.fn(),
    }),
  ))

  openComposer(tree, 0)
  openComposer(tree, 0)
  const sends = tree.root.findAllByProps({ className: 'elves-annotation-thread__send' })
  act(() => tree.root.findAllByType('textarea')[1].props.onChange({ target: { value: 'A reply' } }))
  expect(sends).toHaveLength(2)
  expect(sends[0].props.disabled).toBe(true)
  expect(tree.root.findAllByProps({ className: 'elves-annotation-thread__send' })[1].props.disabled).toBe(false)
})

test('foreground thread props consume only their target presentation', () => {
  const runningTarget = { kind: 'card' as const, cardId: 'shape:a', commentId: 'a' }
  const failedTarget = { kind: 'feedback' as const, feedbackId: 'shape:b' }
  clearAnnotationPresentations()
  setAnnotationThreadPresentation(runningTarget, { running: true, streamingText: 'One reply' })
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'Second reply failed' })

  expect(foregroundThreadProps(runningTarget)).toMatchObject({
    running: true, streamingText: 'One reply', error: undefined,
  })
  expect(foregroundThreadProps(failedTarget)).toMatchObject({
    running: false, streamingText: undefined, error: 'Second reply failed',
  })
  const onReply = vi.fn()
  const onRetry = vi.fn()
  const unsubscribeReply = subscribeAnnotationReply(onReply)
  const unsubscribeRetry = subscribeAnnotationRetry(onRetry)
  foregroundThreadProps(failedTarget).onReply?.('Retry this point')
  foregroundThreadProps(failedTarget).onRetry?.()
  expect(onReply).toHaveBeenCalledWith(failedTarget, 'Retry this point')
  expect(onRetry).toHaveBeenCalledWith(failedTarget)
  unsubscribeReply()
  unsubscribeRetry()
  clearAnnotationPresentations()
})

test('a rendered foreground retry action sends only its failed target', () => {
  const failedTarget = { kind: 'feedback' as const, feedbackId: 'shape:failed' }
  const onRetry = vi.fn()
  clearAnnotationPresentations()
  setAnnotationThreadPresentation(failedTarget, { running: false, error: 'The reply stopped.' })
  const unsubscribeRetry = subscribeAnnotationRetry(onRetry)

  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'failed', type: null, text: 'Retry this thread', resolved: false, author: 'claude' },
    mode: 'open',
    ...foregroundThreadProps(failedTarget),
  }))
  const retry = tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))
  expect(retry).toBeTruthy()
  retry!.props.onClick()
  expect(onRetry).toHaveBeenCalledWith(failedTarget)

  unsubscribeRetry()
  clearAnnotationPresentations()
})

test('a targeted pin clears its temporary preview after pointer or focus leaves', () => {
  vi.useFakeTimers()
  const target = { kind: 'feedback' as const, feedbackId: 'shape:feedback' }
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'feedback', type: 'weak-argument', text: 'Name the causal bridge.', resolved: false, author: 'claude' },
    target,
  }))

  const pin = tree.root.findByProps({ className: 'elves-annotation-pin-wrap' })
  expect(pin.props.onPointerEnter).toEqual(expect.any(Function))
  act(() => pin.props.onPointerEnter())
  expect(annotationHoverTarget()).toEqual(target)
  act(() => pin.props.onPointerLeave())
  act(() => { vi.advanceTimersByTime(100) })
  expect(annotationHoverTarget()).toBeNull()

  act(() => pin.props.onFocus())
  expect(annotationHoverTarget()).toEqual(target)
  act(() => pin.props.onBlur())
  act(() => { vi.advanceTimersByTime(100) })
  expect(annotationHoverTarget()).toBeNull()
  expect(tree.root.findAllByProps({ 'data-testid': 'annotation-popover' })).toHaveLength(0)
  vi.useRealTimers()
})

test('a canvas lock disables a populated reply form without discarding its draft', () => {
  const lockedTree = create(createElement(AnnotationThread, {
    comment: { id: 'locked', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', disabled: true, onReply: vi.fn(),
  }))
  expect(lockedTree.root.findByProps({ className: 'elves-annotation-thread__reply-trigger' }).props.disabled).toBe(true)

  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', onResolve: vi.fn(), onReply: vi.fn(),
  }))
  openComposer(tree)
  const textarea = tree.root.findByType('textarea')
  act(() => textarea.props.onChange({ target: { value: 'My saved draft' } }))
  act(() => tree.update(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', disabled: true, onResolve: vi.fn(), onReply: vi.fn(),
  })))
  expect(tree.root.findByType('textarea').props).toMatchObject({ value: 'My saved draft', disabled: true })
  expect(tree.root.findByProps({ className: 'elves-annotation-thread__send' }).props.disabled).toBe(true)
})

test('retry is unavailable while its thread is running or canvas mutations are locked', () => {
  const onRetry = vi.fn()
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', error: 'The reply stopped.', onRetry,
    running: true,
  }))
  const retry = () => tree.root.findAllByType('button').find((button) => button.children.includes('Retry'))!

  expect(retry().props.disabled).toBe(true)
  retry().props.onClick()
  expect(onRetry).not.toHaveBeenCalled()
  act(() => tree.update(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', error: 'The reply stopped.', onRetry: vi.fn(),
    disabled: true,
  })))
  expect(retry().props.disabled).toBe(true)
})

test('a foreground thread accepts the stage-relative height cap that bounds its transcript', () => {
  const tree = create(createElement(AnnotationThread, {
    comment: { id: 'c1', type: null, text: 'Needs evidence', resolved: false, author: 'claude' },
    mode: 'open', maxHeight: 404,
  }))

  expect(tree.root.findByProps({ 'data-testid': 'annotation-thread' }).props.style).toMatchObject({ maxHeight: 404 })
})

test('a pin name includes a bounded gist of the annotation text', () => {
  const tree = create(createElement(AnnotationPin, {
    comment: { id: 'c1', type: null, text: 'Name the causal bridge explicitly.', resolved: false, author: 'claude' },
  }))
  expect(tree.root.findByProps({ 'data-testid': 'annotation-pin' }).props['aria-label']).toContain('Name the causal bridge explicitly.')
})

test('each annotation pin renders one decorative SVG icon', () => {
  const types = [null, 'needs-evidence', 'weak-argument', 'needs-citation', 'wants-figure', 'counterpoint', 'tighten', 'unclear', 'structure'] as const

  for (const type of types) {
    const tree = create(createElement(AnnotationPin, {
      comment: { id: `pin-${type ?? 'comment'}`, type, text: 'A comment.', resolved: false, author: 'claude' },
    }))
    const icons = tree.root.findAllByType('svg')
    expect(icons).toHaveLength(1)
    expect(icons[0].props['aria-hidden']).toBe('true')
    expect(tree.root.findByProps({ 'data-testid': 'annotation-pin' }).props['aria-label'])
      .toContain(`Open ${annotationPin(type).label} comment`)
  }
})

test('annotation pin icons use a centred fixed wrapper without a transform nudge', () => {
  const css = readFileSync('src/components/annotationThread.css', 'utf8')
  const wrapperRule = css.match(/\.elves-annotation-pin__icon\s*\{([^}]*)\}/)?.[1] ?? ''

  expect(wrapperRule).toMatch(/width:\s*15px/)
  expect(wrapperRule).toMatch(/height:\s*15px/)
  expect(wrapperRule).toMatch(/display:\s*grid/)
  expect(wrapperRule).toMatch(/place-items:\s*center/)
  expect(wrapperRule).toMatch(/line-height:\s*0/)
  expect(wrapperRule).not.toMatch(/transform\s*:/)
  expect(css).toMatch(/\.elves-annotation-pin__icon\s+svg\s*\{[^}]*display:\s*block/)

  const ruleFor = (selector: string) => css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
  const baseRule = ruleFor('\\.elves-annotation-pin(?![-:])')
  expect(baseRule).toMatch(/color:\s*#fff/)
  expect(baseRule).toMatch(/background:\s*var\(--elves-cc-freeform-label\)/)
  expect(baseRule).toMatch(/border-color:\s*var\(--elves-cc-freeform-label\)/)

  const strongColourTypes = {
    'needs-evidence': 'evidence',
    'weak-argument': 'weak',
    'needs-citation': 'citation',
    'wants-figure': 'figure',
    counterpoint: 'counter',
    tighten: 'tighten',
    unclear: 'unclear',
    structure: 'structure',
  } as const
  for (const [type, token] of Object.entries(strongColourTypes)) {
    const typeRule = ruleFor(`\\.elves-annotation-pin\\[data-type="${type}"\\]`)
    expect(typeRule).toMatch(new RegExp(`background:\\s*var\\(--elves-cc-${token}-label\\)`))
    expect(typeRule).toMatch(new RegExp(`border-color:\\s*var\\(--elves-cc-${token}-label\\)`))
  }
})
test('thread controls use the embedded composer and typed header layout', () => {
  const css = readFileSync('src/components/annotationThread.css', 'utf8')
  expect(css).toMatch(/\.elves-annotation-thread__header\s*\{[^}]*justify-content:\s*space-between/s)
  expect(css).toMatch(/\.elves-annotation-thread__type\s*\{[^}]*font-size:\s*12px/s)
  expect(css).toMatch(/\.elves-annotation-thread__type\s*\{[^}]*font-weight:\s*700/s)
  expect(css).toMatch(/\.elves-annotation-thread__type\[data-type="needs-evidence"\]\s*\{[^}]*color:\s*var\(--elves-cc-evidence-label\)/s)
  expect(css).toMatch(/\.elves-annotation-thread__error\s*\{[^}]*display:\s*flex/s)
  expect(css).toMatch(/\.elves-annotation-thread__error\s*\{[^}]*border:\s*1px solid var\(--elves-danger/s)
  expect(css).toMatch(/\.elves-annotation-thread__error-message\s*\{[^}]*min-width:\s*0/s)
  expect(css).toMatch(/\.elves-annotation-thread__error-message[^}]*overflow-wrap:\s*anywhere/s)
  expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*margin-left:\s*auto/s)
  expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*flex:\s*0 0 auto/s)
  expect(css).toMatch(/\.elves-annotation-thread__send\s*\{[^}]*position:\s*absolute/s)
  expect(css).toMatch(/\.elves-annotation-thread__send\s*\{[^}]*border-radius:\s*50%/s)
  expect(css).toMatch(/\.elves-annotation-thread__send\s*\{[^}]*right:\s*8px[^}]*bottom:\s*8px/s)
  expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea\s*\{[^}]*padding:\s*9px 43px 9px 10px/s)
  expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea\s*\{[^}]*resize:\s*none/s)
  expect(css).not.toContain('.elves-annotation-thread__reply-resize')
  expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea:focus-visible\s*\{[^}]*outline:\s*none/s)
  expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea:focus-visible\s*\{[^}]*border-color:\s*var\(--elves-primary\)/s)
  expect(css).toMatch(/\.elves-annotation-thread__reply\s+textarea:focus-visible\s*\{[^}]*box-shadow:\s*0 0 0 3px var\(--elves-primary-tint\)/s)
  expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*display:\s*inline-flex/s)
  expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*border:\s*[^;]+/s)
  expect(css).toMatch(/\.elves-annotation-thread__retry\s*\{[^}]*border-radius:\s*[^;]+/s)
  expect(css).toMatch(/(?=[^{}]*\.elves-annotation-thread__resolve:hover)(?=[^{}]*\.elves-annotation-thread__retry:hover)[^{}]*\{[^}]*\}/s)
  expect(css).toMatch(/(?=[^{}]*\.elves-annotation-thread__resolve:focus-visible)(?=[^{}]*\.elves-annotation-thread__retry:focus-visible)[^{}]*\{[^}]*\}/s)
})
