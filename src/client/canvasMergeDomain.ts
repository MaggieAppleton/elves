export interface CanvasMergeDomainContext {
  isShape: boolean
  isCard: boolean
}

export interface CanvasAtomicFieldGroup {
  keys: readonly string[]
  conflictPath: string[]
}

const LAYOUT_KEYS = ['parentId', 'index', 'x', 'y', 'rotation'] as const
const AUTHORSHIP_KEYS = ['text', 'attribution', 'authoredBy'] as const

export function canvasMergeDomainContext(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): CanvasMergeDomainContext {
  const records = [base, local, remote]
  const isShape = records.every((record) => record.typeName === 'shape')
  return {
    isShape,
    isCard: isShape && records.every((record) => record.type === 'card'),
  }
}

export function atomicFieldGroupsAt(
  context: CanvasMergeDomainContext,
  path: readonly string[],
): CanvasAtomicFieldGroup[] {
  if (context.isShape && path.length === 0) {
    return [{ keys: LAYOUT_KEYS, conflictPath: ['layout'] }]
  }
  if (context.isCard && path.length === 1 && path[0] === 'props') {
    return [{ keys: AUTHORSHIP_KEYS, conflictPath: ['props', 'authorship'] }]
  }
  return []
}
