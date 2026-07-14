import { expect, test, vi } from 'vitest'
import { createPointerDragManager } from '../../src/client/dividerDrag'

function pointerEvent(type: 'pointermove' | 'pointerup' | 'pointercancel', pointerId: number, clientX = 0) {
  const event = new Event(type)
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: clientX },
  })
  return event
}

test('tracks the active pointer until that pointer is released', () => {
  const target = new EventTarget()
  const onActiveChange = vi.fn()
  const onMove = vi.fn()
  const drag = createPointerDragManager(target, onActiveChange)

  drag.start(7, onMove)
  target.dispatchEvent(pointerEvent('pointermove', 7, 320))
  target.dispatchEvent(pointerEvent('pointerup', 7))
  target.dispatchEvent(pointerEvent('pointermove', 7, 640))

  expect(onMove).toHaveBeenCalledOnce()
  expect(onMove.mock.calls[0][0]).toMatchObject({ pointerId: 7, clientX: 320 })
  expect(onActiveChange.mock.calls).toEqual([[true], [false]])
})

test.each(['pointercancel', 'blur'] as const)('%s ends the drag and makes stale moves inert', (endEvent) => {
  const target = new EventTarget()
  const onActiveChange = vi.fn()
  const onMove = vi.fn()
  const drag = createPointerDragManager(target, onActiveChange)

  drag.start(3, onMove)
  target.dispatchEvent(endEvent === 'blur' ? new Event('blur') : pointerEvent(endEvent, 3))
  target.dispatchEvent(pointerEvent('pointermove', 3, 500))

  expect(onMove).not.toHaveBeenCalled()
  expect(onActiveChange.mock.calls).toEqual([[true], [false]])
})

test('a replacement drag retires the old pointer without letting it move or end the new drag', () => {
  const target = new EventTarget()
  const onActiveChange = vi.fn()
  const firstMove = vi.fn()
  const secondMove = vi.fn()
  const drag = createPointerDragManager(target, onActiveChange)

  drag.start(1, firstMove)
  drag.start(2, secondMove)
  target.dispatchEvent(pointerEvent('pointermove', 1, 100))
  target.dispatchEvent(pointerEvent('pointerup', 1))
  target.dispatchEvent(pointerEvent('pointermove', 2, 200))

  expect(firstMove).not.toHaveBeenCalled()
  expect(secondMove).toHaveBeenCalledOnce()
  expect(onActiveChange.mock.calls).toEqual([[true], [false], [true]])

  target.dispatchEvent(pointerEvent('pointerup', 2))
  expect(onActiveChange.mock.calls.at(-1)).toEqual([false])
})

test('explicit cleanup ends the drag once for view changes and unmounts', () => {
  const target = new EventTarget()
  const onActiveChange = vi.fn()
  const onMove = vi.fn()
  const drag = createPointerDragManager(target, onActiveChange)

  drag.start(9, onMove)
  drag.end()
  drag.end()
  target.dispatchEvent(pointerEvent('pointermove', 9, 400))

  expect(onMove).not.toHaveBeenCalled()
  expect(onActiveChange.mock.calls).toEqual([[true], [false]])
})
