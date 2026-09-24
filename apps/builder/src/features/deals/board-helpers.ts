import type { BoardColumnResource, DealResource } from "./schema/resource"

/** Midpoint between two neighbours; mirrors dealService.positionBetween on the server. */
export function positionBetween(
  before: number | null | undefined,
  after: number | null | undefined,
  step = 1000,
): number {
  if (before === null || before === undefined) {
    return after === null || after === undefined ? step : after - step
  }
  if (after === null || after === undefined) {
    return before + step
  }
  return (before + after) / 2
}

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
  const moved: DealResource = { ...deal, stageId: target.stage.id, position }
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
