import { computed, type Computed, type Editor, type TLShape } from 'tldraw'
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

function fanInfoEqual(a: ExpandedCardFanInfo, b: ExpandedCardFanInfo): boolean {
  return a.layoutKey === b.layoutKey && arraysEqual(a.members, b.members)
}

function createCardPageIndexes(editor: Editor): CardPageIndexes {
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

  const infoByCard = new Map<CardId, Computed<CardPageInfo>>()
  const getCardInfoSignal = (cardId: CardId): Computed<CardPageInfo> => {
    let info = infoByCard.get(cardId)
    if (!info) {
      info = computed<CardPageInfo>(
        `card page info ${cardId}`,
        () => {
          const index = pageIndex.get()
          return {
            cardNumber: index.cardNumbers.get(cardId) ?? 0,
            cardCount: index.cardIds.length,
            memberIds: index.membersByRepresentative.get(cardId) ?? EMPTY_MEMBER_IDS,
          }
        },
        { isEqual: cardInfoEqual },
      )
      infoByCard.set(cardId, info)
    }
    return info
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

  const fanInfoByCard = new Map<CardId, Computed<ExpandedCardFanInfo>>()
  const getExpandedFanInfoSignal = (cardId: CardId): Computed<ExpandedCardFanInfo> => {
    let fanInfo = fanInfoByCard.get(cardId)
    if (!fanInfo) {
      fanInfo = computed<ExpandedCardFanInfo>(
        `expanded card fan info ${cardId}`,
        () => {
          const memberIds = getCardInfoSignal(cardId).get().memberIds
          const members = memberIds
            .map((memberId) => editor.getShape<CardShape>(memberId))
            .filter((member): member is CardShape => !!member && member.type === 'card')
          return { layoutKey: fanLayoutKey.get(), members }
        },
        { isEqual: fanInfoEqual },
      )
      fanInfoByCard.set(cardId, fanInfo)
    }
    return fanInfo
  }

  return {
    getCardInfo: (cardId) => getCardInfoSignal(cardId).get(),
    getExpandedFanInfo: (cardId) => getExpandedFanInfoSignal(cardId).get(),
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
