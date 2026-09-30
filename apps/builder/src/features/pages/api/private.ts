import { pageService } from "@chatbotx.io/business/page"
import { pageStatuses } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { ORPCError } from "@orpc/server"
import z from "zod"
import { includeArchivedParam } from "@/features/email-templates/schema/resource"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { checkEmailPreviewRateLimit } from "@/lib/rate-limit/email-preview-rate-limit"
import { workspaceAuthorizedMidddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  pageData,
  pagePreviewInput,
  pagePreviewResource,
  pageResource,
} from "../schema/resource"

/** Custom pages (roadmap B4): workspace-wide, authored like email templates. */
const tags = ["Pages"]
const withPageId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)

const privateListPagesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/pages",
    summary: "List pages",
    tags,
  })
  .input(
    withWorkspaceIdSchema.and(
      z.object({ includeArchived: includeArchivedParam }),
    ),
  )
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(pageResource) }))
  .handler(async ({ input }) => ({
    data: await pageService.list({
      workspaceId: input.workspaceId,
      includeArchived: input.includeArchived,
    }),
  }))

const privateCreatePageAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pages",
    summary: "Create a page",
    tags,
  })
  .input(withWorkspaceIdSchema.and(pageData))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(pageResource)
  .handler(
    async ({ input, context }) =>
      await pageService.create({
        workspaceId: input.workspaceId,
        userId: context.user.id,
        data: {
          name: input.name,
          document: input.document,
          linkTtlHours: input.linkTtlHours,
        },
      }),
  )

const privateUpdatePageAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/pages/{id}",
    summary: "Update a page",
    tags,
  })
  .input(withPageId.and(pageData))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(pageResource)
  .handler(
    async ({ input }) =>
      await pageService.update({
        workspaceId: input.workspaceId,
        id: input.id,
        data: {
          name: input.name,
          document: input.document,
          linkTtlHours: input.linkTtlHours,
        },
      }),
  )

const privateSetPageStatusAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pages/{id}/status",
    summary: "Archive or restore a page",
    description: "Archiving closes every contact link to the page (410).",
    tags,
  })
  .input(withPageId.and(z.object({ status: pageStatuses })))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(pageResource)
  .handler(async ({ input }) => await pageService.setStatus(input))

const privateDeletePageAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/pages/{id}",
    summary: "Delete a page",
    description: "Deletes the page and every contact link to it (404).",
    tags,
  })
  .input(withPageId)
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(z.object({ ok: z.literal(true) }))
  .handler(async ({ input }) => {
    await pageService.delete(input)
    return { ok: true as const }
  })

const privatePreviewPageAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/pages/preview",
    summary: "Preview a page",
    description:
      "Renders a draft document as the public page (sample merge values, no buttons signed). A schema miss returns ok false with each issue's path instead of an error.",
    tags,
  })
  .input(withWorkspaceIdSchema.and(pagePreviewInput))
  .use(workspaceAuthorizedMidddleware, (input) => input.workspaceId)
  .output(pagePreviewResource)
  .handler(async ({ input, context }) => {
    // One budget per user for every document preview (email or page).
    const { limited, retryAfter } = await checkEmailPreviewRateLimit({
      userId: String(context.user.id),
    })
    if (limited) {
      throw new ORPCError("TOO_MANY_REQUESTS", {
        status: 429,
        message: `Too many previews, retry in ${retryAfter}s`,
      })
    }
    return await pageService.preview({
      workspaceId: input.workspaceId,
      document: input.document,
      vars: input.vars,
    })
  })

export const privatePagesAPI = {
  privatePreviewPageAPI,
  privateListPagesAPI,
  privateCreatePageAPI,
  privateUpdatePageAPI,
  privateSetPageStatusAPI,
  privateDeletePageAPI,
}
