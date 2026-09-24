/** Default gap between neighbouring deal cards in a stage. */
export const DEAL_POSITION_STEP = 1000

/**
 * `position` for a card dropped between two neighbours (either may be absent).
 * Shared by the deal service and the board's optimistic move so both sides
 * compute the same midpoint. Non-finite neighbours count as absent.
 */
export function positionBetween(
  before: number | null | undefined,
  after: number | null | undefined,
  step: number = DEAL_POSITION_STEP,
): number {
  const b =
    typeof before === "number" && Number.isFinite(before) ? before : null
  const a = typeof after === "number" && Number.isFinite(after) ? after : null
  if (b === null) {
    return a === null ? step : a - step
  }
  if (a === null) {
    return b + step
  }
  return (b + a) / 2
}
