/**
 * Re-checks, and renews, the claim a smart-delay resume runs under; throws
 * ClaimLostError when the row is no longer this run's (the stuck-running sweep
 * reset it and another resume re-claimed it). A database error propagates as
 * itself, so the caller's normal requeue + retry path handles it.
 */
export type ClaimCheck = () => Promise<void>

/**
 * A claimed resume found its claim taken over between two steps. The new
 * owner re-runs the edge and dispatches its own continuation, so this run
 * stops without starting another step or enqueueing a continuation, without
 * a requeue (the generation CAS would refuse it) and without a retry.
 */
export class ClaimLostError extends Error {
  readonly smartDelayId: string
  readonly generation: number

  constructor(smartDelayId: string, generation: number) {
    super(
      `Smart delay ${smartDelayId} claim generation ${generation} is no longer current`,
    )
    this.name = "ClaimLostError"
    this.smartDelayId = smartDelayId
    this.generation = generation
  }
}
