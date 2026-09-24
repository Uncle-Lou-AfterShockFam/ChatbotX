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
// Deal task events (s192): pinned to the pipeline like ticketCreated.
export const taskCreated = createDealCondition(
  triggerEventTypes.enum.taskCreated,
)
export const taskCompleted = createDealCondition(
  triggerEventTypes.enum.taskCompleted,
)
export const taskOverdue = createDealCondition(
  triggerEventTypes.enum.taskOverdue,
)
export const taskAssigned = createDealCondition(
  triggerEventTypes.enum.taskAssigned,
)

export const DEAL_CONDITION_TYPES = [
  triggerEventTypes.enum.ticketCreated,
  triggerEventTypes.enum.ticketMovedToStage,
  triggerEventTypes.enum.ticketValueChanged,
  triggerEventTypes.enum.ticketStatusChanged,
  triggerEventTypes.enum.ticketPriorityChanged,
  triggerEventTypes.enum.taskCreated,
  triggerEventTypes.enum.taskCompleted,
  triggerEventTypes.enum.taskOverdue,
  triggerEventTypes.enum.taskAssigned,
] as const
