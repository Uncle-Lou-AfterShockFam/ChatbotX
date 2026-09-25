import {
  type WaitStepSchema,
  waitStepDelayTypes,
} from "@chatbotx.io/flow-config"
import { containsVariablePlaceholder } from "@chatbotx.io/utils/variables"
import { resolveContactVariablesDeep } from "@chatbotx.io/variables"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow"

type Props = ExecuteStepProps<WaitStepSchema>

/**
 * A value-scoped event wait captures its match value ONCE, here, for this
 * contact (`{{raw:wp_order_id}}` -> "3635"). A value that does not resolve to
 * a plain literal becomes "", which the resume matcher never matches: the
 * event edge fails closed and the timeout edge still fires. Compare like with
 * like: the capture is the SOURCE field's stored value and the event carries
 * the WATCHED field's normalized value, so give both the same field type.
 */
export async function resolveWaitMatchValue(
  step: WaitStepSchema,
  contactInbox: NonNullable<Props["contactInbox"]>,
  conversation: Props["conversation"],
): Promise<string | undefined> {
  if (
    step.delayType !== waitStepDelayTypes.enum.event ||
    !step.matchValue ||
    !containsVariablePlaceholder(step.matchValue)
  ) {
    return
  }
  // A lookup failure propagates: the job retries before any row exists (flow
  // handlers' convention), instead of parking a wait that can never match.
  const resolved = (
    await resolveContactVariablesDeep(contactInbox.contactId, step.matchValue, {
      contactInbox,
      conversation,
    })
  ).trim()
  if (resolved && !containsVariablePlaceholder(resolved)) {
    return resolved
  }
  logger.warn(
    { stepId: step.id, contactInboxId: contactInbox.id },
    "Wait matchValue did not resolve; only the timeout edge can fire",
  )
  return ""
}
