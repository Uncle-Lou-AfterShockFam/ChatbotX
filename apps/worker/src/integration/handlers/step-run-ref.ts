import { createHash } from "node:crypto"

/**
 * An idempotency ref per (flow run, step) for a step that creates something
 * once (a signature document, a page link): a BullMQ retry of the step with
 * the same run key gets the same ref. Hashed because a run key is not
 * ref-safe. Only as stable as the run key. A resumed wait runs under its row
 * (smartDelayRunKey), so a requeued run re-claimed by another job reuses it;
 * a challenge reply runs under its job id (step-challenge-<conv>-<message>).
 * A run with no key at all gets a fresh fallback per attempt (flow.ts
 * resolveFlowExecutionKey): there a retry creates a second one.
 */
export const stepRunRef = (
  prefix: string,
  flowExecutionKey: string,
  stepId: string,
): string =>
  `${prefix}:${createHash("sha256")
    .update(JSON.stringify([flowExecutionKey, stepId]))
    .digest("hex")
    .slice(0, 40)}`
