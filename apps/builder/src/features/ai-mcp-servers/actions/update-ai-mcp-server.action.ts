"use server"

import { aiMcpServerService } from "@chatbotx.io/business"
import { notFoundException } from "@chatbotx.io/business/errors"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { resolveBotFieldVariableText } from "@chatbotx.io/variables"
import { getTranslations } from "next-intl/server"
import { returnValidationErrors } from "next-safe-action"
import { isValidationException } from "@/lib/errors/validation-exception"
import { workspaceActionClient } from "@/lib/safe-action"
import { mergeStoredAuth } from "../lib/merge-stored-auth"
import { updatePrivateAIMcpServerRequest } from "../schema/action"

export const updateAIMcpServerAction = workspaceActionClient
  .bindArgsSchemas([zodBigintAsString(), zodBigintAsString()])
  .inputSchema(updatePrivateAIMcpServerRequest)
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [workspaceId, id],
      parsedInput,
    } = props
    const t = await getTranslations()

    const mcpServer = await aiMcpServerService.findBy({
      where: {
        id,
        workspaceId,
      },
    })
    if (!mcpServer) {
      throw notFoundException(
        t("messages.featureNotFound", { feature: t("fields.mcpServer.label") }),
      )
    }

    // The form never receives the stored secret; an empty token or header
    // value keeps the stored one (s232a).
    const merged = mergeStoredAuth(parsedInput.auth, mcpServer.auth)
    if (merged.status === "missing") {
      return returnValidationErrors(updatePrivateAIMcpServerRequest, {
        auth: { _errors: [t("forms.issues.required")] },
      })
    }

    if (parsedInput.auth.type === "token" && parsedInput.auth.token !== "") {
      const resolution = await resolveBotFieldVariableText({
        text: parsedInput.auth.token,
        workspaceId,
      })
      if (resolution.status !== "resolved") {
        return returnValidationErrors(updatePrivateAIMcpServerRequest, {
          auth: { token: { _errors: [t("validation.invalidApiKey")] } },
        })
      }
    }

    try {
      await aiMcpServerService.update(
        { workspaceId, id },
        { ...parsedInput, auth: merged.auth },
      )
    } catch (error) {
      if (isValidationException(error)) {
        return returnValidationErrors(updatePrivateAIMcpServerRequest, {
          name: {
            _errors: [
              t("messages.nameAlreadyExists", {
                feature: t("fields.mcpServer.label"),
              }),
            ],
          },
        })
      }

      throw error
    }
  })
