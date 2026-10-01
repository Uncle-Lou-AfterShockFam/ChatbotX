"use server"

import {
  messengerIntegrationService,
  messengerMessageTemplateService,
} from "@chatbotx.io/business"
import { createPageMessageTemplate } from "@chatbotx.io/integration-messenger/apis/message-templates"
import type { MessengerAuthValue } from "@chatbotx.io/integration-messenger/schema"
import { invalidateCacheByTags } from "@chatbotx.io/redis"
import { SdkException } from "@chatbotx.io/sdk"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { chunk } from "remeda"
import { z } from "zod"
import { workspaceActionClient } from "@/lib/safe-action"
import { prepareComponentsForClone } from "../lib/prepare-components-for-clone"
import { syncMessengerMessageTemplatesForIntegration } from "../lib/sync-message-templates"

export const cloneMessengerMessageTemplateAction = workspaceActionClient
  .bindArgsSchemas([
    zodBigintAsString(),
    zodBigintAsString(),
    zodBigintAsString(),
  ])
  .schema(
    z.object({
      targetIntegrationMessengerIds: z.array(zodBigintAsString()).min(1),
    }),
  )
  .action(async (props) => {
    const {
      bindArgsParsedInputs: [
        workspaceId,
        sourceIntegrationMessengerId,
        templateId,
      ],
      parsedInput: { targetIntegrationMessengerIds },
      ctx: { user },
    } = props

    // Load source template, verifying it belongs to the source integration + workspace
    const sourceTemplate =
      await messengerMessageTemplateService.findByIdForIntegration({
        id: templateId,
        integrationMessengerId: sourceIntegrationMessengerId,
        workspaceId,
      })

    if (!sourceTemplate) {
      throw new Error("Source template not found")
    }

    // Source integration (for its pageId — never clone a template onto its own page).
    const sourceIntegration =
      await messengerIntegrationService.findByIdForWorkspace({
        id: sourceIntegrationMessengerId,
        workspaceId,
      })

    // Authorize per target: the user must be an admin (owner or superAdmin)
    // of the target's workspace, and the target must not be the source's own
    // Facebook Page. Memberships are read uncached so a just-revoked admin
    // cannot clone across a workspace boundary.
    const requested = new Set(targetIntegrationMessengerIds)
    const cloneTargets =
      await messengerIntegrationService.listCloneTargetsForUser({
        userId: user.id,
        excludePageId: sourceIntegration?.pageId,
        authoritative: true,
      })
    const targets = cloneTargets.filter((target) => requested.has(target.id))

    if (targets.length === 0) {
      throw new Error("No authorized target channels found")
    }

    const succeeded: { channel: string }[] = []
    const failed: { channel: string; error: string }[] = []

    const BATCH_SIZE = 5

    const cloneOne = async (
      target: (typeof targets)[number],
    ): Promise<void> => {
      const auth = target.auth as MessengerAuthValue
      try {
        // Re-upload IMAGE headers to the target page before creating the template.
        const components = await prepareComponentsForClone(
          // biome-ignore lint/suspicious/noExplicitAny: Meta API component shape varies
          sourceTemplate.components as any[],
          auth,
        )

        const resp = await createPageMessageTemplate(auth, {
          name: sourceTemplate.name,
          category: sourceTemplate.category as
            | "AUTHENTICATION"
            | "MARKETING"
            | "UTILITY",
          language: sourceTemplate.language,
          parameter_format: sourceTemplate.parameterFormat,
          components,
        })

        if (resp.status === "APPROVED") {
          await syncMessengerMessageTemplatesForIntegration({
            workspaceId: target.workspaceId,
            integrationMessenger: target,
            templateId: resp.id,
            templateName: sourceTemplate.name,
            templateLanguage: sourceTemplate.language,
          })
          succeeded.push({ channel: target.name })
        } else {
          failed.push({
            channel: target.name,
            error: `Template returned status: ${resp.status}`,
          })
        }
      } catch (error) {
        const message =
          error instanceof SdkException || error instanceof Error
            ? error.message
            : "Unknown error occurred"
        failed.push({ channel: target.name, error: message })
      }
    }

    const batches = chunk(targets, BATCH_SIZE)
    for (const batch of batches) {
      await Promise.allSettled(batch.map(cloneOne))
    }

    // Revalidate every workspace that received a clone, plus the source.
    const affectedWorkspaceIds = new Set(
      targets.map((target) => target.workspaceId),
    )
    affectedWorkspaceIds.add(workspaceId)
    for (const affectedWorkspaceId of affectedWorkspaceIds) {
      await invalidateCacheByTags([
        `workspaces:${affectedWorkspaceId}#messenger#messageTemplates`,
      ])
    }

    return { succeeded, failed }
  })
