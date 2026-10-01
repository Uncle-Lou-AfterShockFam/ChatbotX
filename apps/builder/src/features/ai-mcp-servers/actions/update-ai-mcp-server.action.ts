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
    // value keeps the stored one, for the stored URL only (s232a).
    const merged = mergeStoredAuth(parsedInput.auth, parsedInput.url, mcpServer)
    if (merged.status === "missing") {
      // On the field itself: the form renders auth.token and
      // auth.headers.N.value, never a bare `auth` error.
      const required = { _errors: [t("forms.issues.required")] }
      const headerIndex = merged.path.startsWith("headers.")
        ? Number(merged.path.split(".")[1])
        : null
      return returnValidationErrors(updatePrivateAIMcpServerRequest, {
        auth:
          headerIndex === null
            ? { token: required }
            : { headers: { [headerIndex]: { value: required } } },
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
