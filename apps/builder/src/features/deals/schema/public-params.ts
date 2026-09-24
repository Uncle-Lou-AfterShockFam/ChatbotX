import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"

/** `{id}` of every `/v1/deals/{id}/...` sub-resource route (tasks, comments). */
export const dealIdParam = z.object({
  id: zodBigintAsString().describe("Deal id. Get it from `deals.list`."),
})
