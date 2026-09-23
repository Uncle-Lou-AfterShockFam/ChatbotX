import {
  type TriggerEventType,
  triggerEventTypes,
} from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/**
 * Deal (`ticket*`) conditions always carry a sourceId: the pipeline for
 * created / value / status / priority, the DESTINATION stage for a move.
 * The worker matches it exactly, so an empty sourceId can never fire.
 */
const createDealCondition = (type: TriggerEventType) =>
  z.object({
    id: zodBigintAsString().optional(),
    type: z.literal(type),
    sourceId: z.string().min(1, "Required"),
  })

export const ticketCreated = createDealCondition(
  triggerEventTypes.enum.ticketCreated,
)
export const ticketMovedToStage = createDealCondition(
  triggerEventTypes.enum.ticketMovedToStage,
)
export const ticketValueChanged = createDealCondition(
  triggerEventTypes.enum.ticketValueChanged,
)
export const ticketStatusChanged = createDealCondition(
  triggerEventTypes.enum.ticketStatusChanged,
)
export const ticketPriorityChanged = createDealCondition(
  triggerEventTypes.enum.ticketPriorityChanged,
)

export const DEAL_CONDITION_TYPES = [
  triggerEventTypes.enum.ticketCreated,
  triggerEventTypes.enum.ticketMovedToStage,
  triggerEventTypes.enum.ticketValueChanged,
  triggerEventTypes.enum.ticketStatusChanged,
  triggerEventTypes.enum.ticketPriorityChanged,
] as const
