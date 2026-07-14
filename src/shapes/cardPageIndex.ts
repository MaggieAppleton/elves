import { computed, type Editor, type TLShape } from 'tldraw'
import type { CardShape } from './CardShapeUtil'

type CardId = CardShape['id']

interface CardStructure {
  id: CardId
  mergedInto: string | null
}

interface CardPageIndex {
  cardIds: readonly CardId[]
  cardNumbers: ReadonlyMap<CardId, number>
  membersByRepresentative: ReadonlyMap<string, readonly CardId[]>
}

export interface CardPageInfo {
  cardNumber: number
  cardCount: number
  memberIds: readonly CardId[]
}

export interface ExpandedCardFanInfo {
  layoutKey: string
  members: readonly CardShape[]
}

interface CardPageIndexes {
  getCardInfo(cardId: CardId): CardPageInfo
  getExpandedFanInfo(cardId: CardId): ExpandedCardFanInfo
  enableDiagnostics(): CardPageIndexDiagnostics
}

export interface CardPageIndexDiagnostics {
  pageScans: number
  cardNumberLookups: number
}

const EMPTY_MEMBER_IDS: readonly CardId[] = Object.freeze([])
const indexesByEditor = new WeakMap<Editor, CardPageIndexes>()

function arraysEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((value, index) => value === b[index]))
}

function pageIndexesEqual(a: CardPageIndex, b: CardPageIndex): boolean {
  if (!arraysEqual(a.cardIds, b.cardIds)) return false
  if (a.membersByRepresentative.size !== b.membersByRepresentative.size) return false
  for (const [representativeId, members] of a.membersByRepresentative) {
    const nextMembers = b.membersByRepresentative.get(representativeId)
    if (!nextMembers || !arraysEqual(members, nextMembers)) return false
  }
  return true
}

function cardInfoEqual(a: CardPageInfo, b: CardPageInfo): boolean {
  return a.cardNumber === b.cardNumber &&
    a.cardCount === b.cardCount &&
    arraysEqual(a.memberIds, b.memberIds)
}

function createCardPageIndexes(editor: Editor): CardPageIndexes {
  const diagnostics = {
    enabled: false,
    pageScans: 0,
    cardNumberLookups: 0,
  }
  const structureByShape = editor.store.createComputedCache<CardStructure | null, TLShape>(
    'card page structure record',
    (shape) => shape.type === 'card'
      ? {
          id: shape.id as CardId,
          mergedInto: (shape as CardShape).props.mergedInto,
        }
      : null,
    {
      areRecordsEqual: (a, b) =>
        a.type === b.type &&
        (a.type !== 'card' ||
          (a as CardShape).props.mergedInto === (b as CardShape).props.mergedInto),
    },
  )

  const pageIndex = computed<CardPageIndex>(
    'card page index',
    () => {
      if (diagnostics.enabled) diagnostics.pageScans += 1
      const cardIds: CardId[] = []
      const membersByRepresentative = new Map<string, CardId[]>()
      for (const shapeId of editor.getCurrentPageShapeIds()) {
        const structure = structureByShape.get(shapeId)
        if (!structure) continue
        cardIds.push(structure.id)
        if (structure.mergedInto) {
          const members = membersByRepresentative.get(structure.mergedInto)
          if (members) members.push(structure.id)
          else membersByRepresentative.set(structure.mergedInto, [structure.id])
        }
      }
      cardIds.sort((a, b) => a.localeCompare(b))
      const cardNumbers = new Map(cardIds.map((cardId, index) => [cardId, index + 1]))
      return { cardIds, cardNumbers, membersByRepresentative }
    },
    { isEqual: pageIndexesEqual },
  )

  const infoByCard = editor.store.createCache<CardPageInfo, CardShape>((cardId) =>
    computed<CardPageInfo>(
      `card page info ${cardId}`,
      () => {
        const index = pageIndex.get()
        if (diagnostics.enabled) diagnostics.cardNumberLookups += 1
        return {
          cardNumber: index.cardNumbers.get(cardId) ?? 0,
          cardCount: index.cardIds.length,
          memberIds: index.membersByRepresentative.get(cardId) ?? EMPTY_MEMBER_IDS,
        }
      },
      { isEqual: cardInfoEqual },
    ),
  )

  const getCardInfo = (cardId: CardId): CardPageInfo => infoByCard.get(cardId) ?? {
    cardNumber: 0,
    cardCount: pageIndex.get().cardIds.length,
    memberIds: EMPTY_MEMBER_IDS,
  }

  const layoutByShape = editor.store.createComputedCache<string, TLShape>(
    'card fan layout record',
    (shape) => `${shape.id}:${shape.x}:${shape.y}:${shape.parentId}`,
    {
      areRecordsEqual: (a, b) =>
        a.x === b.x && a.y === b.y && a.parentId === b.parentId,
    },
  )
  const fanLayoutKey = computed(
    'card fan page layout',
    () => Array.from(
      editor.getCurrentPageShapeIds(),
      (shapeId) => layoutByShape.get(shapeId) ?? '',
    ).join('|'),
  )

  const getExpandedFanInfo = (cardId: CardId): ExpandedCardFanInfo => {
    const memberIds = getCardInfo(cardId).memberIds
    const members = memberIds
      .map((memberId) => editor.getShape<CardShape>(memberId))
      .filter((member): member is CardShape => !!member && member.type === 'card')
    return { layoutKey: fanLayoutKey.get(), members }
  }

  return {
    getCardInfo,
    getExpandedFanInfo,
    enableDiagnostics: () => {
      diagnostics.enabled = true
      return diagnostics
    },
  }
}

function indexesFor(editor: Editor): CardPageIndexes {
  let indexes = indexesByEditor.get(editor)
  if (!indexes) {
    indexes = createCardPageIndexes(editor)
    indexesByEditor.set(editor, indexes)
  }
  return indexes
}

export function cardPageInfo(editor: Editor, cardId: CardId): CardPageInfo {
  return indexesFor(editor).getCardInfo(cardId)
}

/** Read only for an expanded card; this activates the shared page-layout graph. */
export function expandedCardFanInfo(editor: Editor, cardId: CardId): ExpandedCardFanInfo {
  return indexesFor(editor).getExpandedFanInfo(cardId)
}

/** @internal Test-only counters for guarding the page-index performance contract. */
export function __cardPageIndexDiagnosticsForTests(editor: Editor): CardPageIndexDiagnostics {
  return indexesFor(editor).enableDiagnostics()
}
