"use server"

import {
  integrationOpenaiCompatibleService,
  isOpenaiCompatiblePresetAlreadyConnectedError,
  isSameOpenaiCompatibleBaseUrl,
  validateOpenaiCompatibleBaseUrlForEnvironment,
} from "@chatbotx.io/business"
import { ChatbotXException } from "@chatbotx.io/business/errors"
import { secretTextAuthSchema } from "@chatbotx.io/sdk"
import { getTranslations } from "next-intl/server"
import { returnValidationErrors } from "next-safe-action"
import {
  type WorkspaceIdAndIdRequestParams,
  workspaceIdAndIdRequestParams,
} from "@/features/common/schema"
import { settingsActionClient } from "@/lib/safe-action"
import { verifyOpenaiCompatibleProvider } from "../lib"
import {
  resolveOpenaiCompatibleDefaultModel,
  type UpdateOpenaiCompatibleEnabledSchema,
  type UpdateOpenaiCompatibleSchema,
  updateOpenaiCompatibleEnabledSchema,
  updateOpenaiCompatibleSchema,
} from "../schema/request"

export const updateOpenaiCompatibleEnabledAction = settingsActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(updateOpenaiCompatibleEnabledSchema)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      parsedInput: UpdateOpenaiCompatibleEnabledSchema
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      await integrationOpenaiCompatibleService.update(
        workspaceId,
        integrationId,
        parsedInput,
      )
    },
  )

export const updateOpenaiCompatibleAction = settingsActionClient
  .bindArgsSchemas(workspaceIdAndIdRequestParams)
  .inputSchema(updateOpenaiCompatibleSchema)
  .action(
    async ({
      parsedInput,
      bindArgsParsedInputs: [workspaceId, integrationId],
    }: {
      parsedInput: UpdateOpenaiCompatibleSchema
      bindArgsParsedInputs: WorkspaceIdAndIdRequestParams
    }) => {
      const t = await getTranslations()
      const apiKey = parsedInput.apiKey?.trim()
      let baseURL = parsedInput.baseURL

      if (apiKey || parsedInput.baseURL) {
        const existing =
          await integrationOpenaiCompatibleService.findByWorkspaceIdAndId({
            workspaceId,
            id: integrationId,
          })
        try {
          baseURL = await validateOpenaiCompatibleBaseUrlForEnvironment(
            baseURL ?? existing?.baseURL ?? "",
          )
        } catch (error) {
          if (isBaseUrlValidationError(error)) {
            return returnValidationErrors(updateOpenaiCompatibleSchema, {
              baseURL: {
                _errors: [t("openaiCompatible.validation.invalidBaseURL")],
              },
            })
          }
          throw error
        }
        // The stored key is reused only for the stored base URL (s233a): a
        // new URL with "keep the key" would send the workspace's key to a
        // host the caller picked, at verify time and on every later call.
        if (
          !(apiKey || isSameOpenaiCompatibleBaseUrl(baseURL, existing?.baseURL))
        ) {
          return returnValidationErrors(updateOpenaiCompatibleSchema, {
            apiKey: {
              _errors: [
                t("openaiCompatible.validation.apiKeyRequiredForNewBaseURL"),
              ],
            },
          })
        }
        const existingAuth = secretTextAuthSchema.safeParse(existing?.auth)
        const verifyResult = await verifyOpenaiCompatibleProvider({
          apiKey:
            apiKey ||
            (existingAuth.success ? existingAuth.data.secretText : undefined),
          baseURL,
        })

        if (!verifyResult.ok) {
          if (verifyResult.reason === "unsafe_base_url") {
            return returnValidationErrors(updateOpenaiCompatibleSchema, {
              baseURL: {
                _errors: [t("openaiCompatible.validation.invalidBaseURL")],
              },
            })
          }
          return returnValidationErrors(updateOpenaiCompatibleSchema, {
            apiKey: {
              _errors: [t("validation.invalidApiKey")],
            },
          })
        }
      }

      try {
        await integrationOpenaiCompatibleService.update(
          workspaceId,
          integrationId,
          {
            ...parsedInput,
            ...(baseURL === undefined ? {} : { baseURL }),
            ...(apiKey ? { apiKey } : { apiKey: undefined }),
            ...(parsedInput.defaultModel || !parsedInput.preset
              ? {}
              : {
                  defaultModel: resolveOpenaiCompatibleDefaultModel({
                    preset: parsedInput.preset,
                  }),
                }),
          },
        )
      } catch (error) {
        if (isBaseUrlValidationError(error)) {
          return returnValidationErrors(updateOpenaiCompatibleSchema, {
            baseURL: {
              _errors: [t("openaiCompatible.validation.invalidBaseURL")],
            },
          })
        }
        // The service enforces the same binding for every caller.
        if (
          error instanceof ChatbotXException &&
          error.code === "apiKeyRequiredForNewBaseUrl"
        ) {
          return returnValidationErrors(updateOpenaiCompatibleSchema, {
            apiKey: {
              _errors: [
                t("openaiCompatible.validation.apiKeyRequiredForNewBaseURL"),
              ],
            },
          })
        }
        if (isOpenaiCompatiblePresetAlreadyConnectedError(error)) {
          return returnValidationErrors(updateOpenaiCompatibleSchema, {
            preset: {
              _errors: [
                t("openaiCompatible.validation.presetAlreadyConnected"),
              ],
            },
          })
        }
        throw error
      }
    },
  )

const isBaseUrlValidationError = (error: unknown): error is ChatbotXException =>
  error instanceof ChatbotXException &&
  (error.code === "invalidBaseUrl" || error.code === "ssrfBlocked")
