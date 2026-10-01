import "server-only"

import {
  automatedResponseService,
  type UpdateAutomatedResponseRequest,
} from "@chatbotx.io/business"
import type { AutomatedResponseType } from "@chatbotx.io/database/partials"
import { returnValidationErrors } from "next-safe-action"
import { isValidationException } from "@/lib/errors/validation-exception"
import { updateAutomatedResponseRequest } from "../schema/action"

export const updateAutomatedResponse = async (
  ctx: { workspaceId: string; id: string; type: AutomatedResponseType },
  parsedInput: UpdateAutomatedResponseRequest,
) => {
  try {
    // `text`/`flowId` mutual-exclusion and cross-workspace `flowId`
    // validation live in `automatedResponseService.update` so every caller
    // (this action and the public API) gets the same invariants — caught
    // here so the form still sees a field-level error instead of a
    // generic toast.
    await automatedResponseService.update(ctx, parsedInput)
  } catch (error) {
    if (isValidationException(error)) {
      return returnValidationErrors(updateAutomatedResponseRequest, {
        _errors: ["Validation Exception"],
        flowId: { _errors: [error.message] },
      })
    }

    throw error
  }
}
