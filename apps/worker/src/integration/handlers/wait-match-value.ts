import {
  type WaitStepSchema,
  waitStepDelayTypes,
} from "@chatbotx.io/flow-config"
import { containsVariablePlaceholder } from "@chatbotx.io/utils/variables"
import { contactVariableService } from "@chatbotx.io/variables"
import { logger } from "../../lib/logger"
import type { ExecuteStepProps } from "./flow"

type Props = ExecuteStepProps<WaitStepSchema>

/**
 * A value-scoped event wait captures its match value ONCE, here, for this
 * contact (`{{raw:wp_order_id}}` -> "3635"). Anything that does not resolve to
 * a plain literal becomes "", which the resume matcher never matches: the
 * event edge fails closed and the timeout edge still fires.
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
  try {
    const variables = await contactVariableService.getAll({
      contactId: contactInbox.contactId,
      contactInbox,
      conversation,
    })
    const resolved = (
      await contactVariableService.replaceAll({
        text: step.matchValue,
        variables,
      })
    ).trim()
    if (resolved && !containsVariablePlaceholder(resolved)) {
      return resolved
    }
    logger.warn(
      { stepId: step.id, contactInboxId: contactInbox.id },
      "Wait matchValue did not resolve; only the timeout edge can fire",
    )
  } catch (err) {
    logger.error(
      { err, stepId: step.id },
      "Failed to resolve wait matchValue; only the timeout edge can fire",
    )
  }
  return ""
}
