import { positionBetween } from "@chatbotx.io/utils/deal-position"
import type { BoardColumnResource, BoardDealResource } from "./schema/resource"

export { positionBetween } from "@chatbotx.io/utils/deal-position"

/**
 * Apply a drop to the column list optimistically: the card leaves its column,
 * lands at `index` in the destination with a midpoint position.
 */
export function applyMove(
  columns: BoardColumnResource[],
  move: { cardId: string; toColumnId: string; index: number },
): { columns: BoardColumnResource[]; position: number } | null {
  const source = columns.find((c) => c.deals.some((d) => d.id === move.cardId))
  const deal = source?.deals.find((d) => d.id === move.cardId)
  if (!(source && deal)) {
    return null
  }
  const target = columns.find((c) => c.stage.id === move.toColumnId)
  if (!target) {
    return null
  }
  const targetDeals = target.deals.filter((d) => d.id !== move.cardId)
  const index = Math.max(0, Math.min(move.index, targetDeals.length))
  const position = positionBetween(
    targetDeals[index - 1]?.position,
    targetDeals[index]?.position,
  )
  // the spread keeps the card counts (s198)
  const moved: BoardDealResource = {
    ...deal,
    stageId: target.stage.id,
    position,
  }
  const nextTarget = [
    ...targetDeals.slice(0, index),
    moved,
    ...targetDeals.slice(index),
  ]
  return {
    position,
    columns: columns.map((c) => {
      if (c.stage.id === target.stage.id) {
        return { ...c, deals: nextTarget }
      }
      if (c.stage.id === source.stage.id) {
        return { ...c, deals: c.deals.filter((d) => d.id !== move.cardId) }
      }
      return c
    }),
  }
}
