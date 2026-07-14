export interface PointerDragManager {
  start(pointerId: number, onMove: (event: PointerEvent) => void): void
  end(): void
}

export function createPointerDragManager(
  target: EventTarget,
  onActiveChange: (active: boolean) => void,
): PointerDragManager {
  let stopActiveDrag: (() => void) | null = null

  const end = () => stopActiveDrag?.()

  return {
    start(pointerId, onMove) {
      end()

      let active = true
      const matchesPointer = (event: Event) => (event as PointerEvent).pointerId === pointerId
      const handleMove: EventListener = (event) => {
        if (active && matchesPointer(event)) onMove(event as PointerEvent)
      }
      const finish = () => {
        if (!active) return
        active = false
        target.removeEventListener('pointermove', handleMove)
        target.removeEventListener('pointerup', handlePointerEnd)
        target.removeEventListener('pointercancel', handlePointerEnd)
        target.removeEventListener('blur', finish)
        if (stopActiveDrag === finish) stopActiveDrag = null
        onActiveChange(false)
      }
      const handlePointerEnd: EventListener = (event) => {
        if (matchesPointer(event)) finish()
      }

      target.addEventListener('pointermove', handleMove)
      target.addEventListener('pointerup', handlePointerEnd)
      target.addEventListener('pointercancel', handlePointerEnd)
      target.addEventListener('blur', finish)
      stopActiveDrag = finish
      onActiveChange(true)
    },
    end,
  }
}
