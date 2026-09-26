import {
  companyActivityService,
  companyNoteService,
  companyService,
  conversationService,
  crmTimelineService,
  questionnaireSubmissionService,
} from "@chatbotx.io/business"
import { dealService } from "@chatbotx.io/business/deal"
import { dealTaskService } from "@chatbotx.io/business/deal-task"
import { zodBigintAsString } from "@chatbotx.io/utils"
import z from "zod"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { dealTaskResource } from "@/features/deal-tasks/schema/resource"
import { viewerFromContext } from "@/features/deals/lib/viewer"
import { dealResource } from "@/features/deals/schema/resource"
import { withWorkspaceIdSchema } from "@/features/workspaces/schema/resource"
import { fetchAllListPages } from "@/lib/query/fetch-all-list-pages"
import { contactsAccessAuthorizedMiddleware } from "@/middlewares/auth"
import { authorizedAPI } from "@/orpc"
import {
  companyActivityResource,
  companyMetricsResource,
  companyNoteResource,
  conversationSummaryResource,
  submissionSummaryResource,
  timelineKindSchema,
  timelinePageResource,
} from "../schema/resource"

/**
 * Contact / Company 360 (s195). Every route sits behind the contacts-section
 * gate; anything that returns deals or deal-derived rows passes the viewer so
 * a members-only pipeline never leaks through a company or contact rollup.
 * Inputs are CLOSED objects with capped `limit`s.
 */
const tags = ["CRM"]

const withCompanyId = withWorkspaceIdSchema.and(
  z.object({ id: zodBigintAsString() }),
)
const withContactId = withWorkspaceIdSchema.and(
  z.object({ contactId: zodBigintAsString() }),
)
const limitField = z.coerce.number().int().min(1).max(200).optional()
const timelineQuery = z.object({
  kinds: z.array(timelineKindSchema).max(6).optional(),
  cursor: z.string().max(64).nullish(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
const noteBody = z.object({
  text: z.string().trim().min(1).max(4000),
})
const withNoteId = withCompanyId.and(z.object({ noteId: zodBigintAsString() }))

/** Deals of the company as the viewer may see them (at most 200, newest first). */
async function companyDeals(input: {
  workspaceId: string
  id: string
  viewer: ReturnType<typeof viewerFromContext>
}) {
  await companyService.findOrFail({
    workspaceId: input.workspaceId,
    id: input.id,
  })
  // Every deal, newest first, not one call the service caps at 50 (s205).
  return await fetchAllListPages(
    (page) =>
      dealService.list({
        workspaceId: input.workspaceId,
        companyId: input.id,
        viewer: input.viewer,
        ...page,
      }),
    { desc: true },
  )
}

async function conversationSummaries(input: {
  workspaceId: string
  contactIds: string[]
}) {
  const rows = await conversationService.findManyByContactIds({
    workspaceId: input.workspaceId,
    contactIds: input.contactIds,
    with: { contact: { columns: { id: true, fullName: true } } },
  })
  return rows
    .filter((row) => row.sourceId === null)
    .sort(
      (a, b) =>
        (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0),
    )
    .map((row) => ({
      id: row.id,
      contactId: row.contactId,
      contactName:
        (row as unknown as { contact?: { fullName: string | null } }).contact
          ?.fullName ?? null,
      lastActivityAt: row.lastActivityAt,
      archivedAt: row.archivedAt,
      contactRepliedAt: row.contactRepliedAt,
      adminRepliedAt: row.adminRepliedAt,
    }))
}

/** Exact numeric(14,2) sums in BigInt cents, ONE entry per currency (a EUR deal never lands in a USD figure). */
function sumByCurrency(
  deals: { value: string | null; currency: string }[],
): Record<string, string> {
  const cents = new Map<string, bigint>()
  for (const deal of deals) {
    if (!deal.value) {
      continue
    }
    const [whole = "0", frac = ""] = deal.value.split(".")
    const sign = whole.startsWith("-") ? -1n : 1n
    const w = BigInt(whole.replace("-", "") || "0")
    const f = BigInt(`${frac}00`.slice(0, 2) || "0")
    cents.set(
      deal.currency,
      (cents.get(deal.currency) ?? 0n) + sign * (w * 100n + f),
    )
  }
  const out: Record<string, string> = {}
  for (const [currency, total] of cents) {
    const sign = total < 0n ? "-" : ""
    const abs = total < 0n ? -total : total
    out[currency] =
      `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`
  }
  return out
}

// ---- company ---------------------------------------------------------------

const privateGetCompanyMetricsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/metrics",
    summary: "Header numbers of the company page",
    tags,
  })
  .input(withCompanyId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(companyMetricsResource)
  .handler(async ({ input, context }) => {
    const viewer = viewerFromContext(context)
    const accessScope = await requireContactPermissionScope(input.workspaceId)
    const deals = await companyDeals({ ...input, viewer })
    const [counts, tasks, timeline] = await Promise.all([
      companyService.countContacts({
        workspaceId: input.workspaceId,
        companyIds: [input.id],
        accessScope,
      }),
      dealTaskService.listForDealsOf({
        workspaceId: input.workspaceId,
        parent: { companyId: input.id },
        viewer,
        limit: 200,
      }),
      crmTimelineService.forCompany({
        workspaceId: input.workspaceId,
        companyId: input.id,
        limit: 1,
        viewer,
        accessScope,
      }),
    ])
    const now = Date.now()
    const open = deals.filter((d) => d.status === "open")
    const openTasks = tasks.filter((t) => t.status === "open")
    return {
      contacts: counts.get(input.id) ?? 0,
      openDeals: open.length,
      openValue: sumByCurrency(open),
      wonValue: sumByCurrency(deals.filter((d) => d.status === "won")),
      openTasks: openTasks.length,
      overdueTasks: openTasks.filter(
        (t) => t.dueAt !== null && t.dueAt.getTime() < now,
      ).length,
      lastActivityAt: timeline.data[0]?.at ?? null,
    }
  })

const privateListCompanyDealsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/deals",
    summary: "Deals of a company the viewer may see",
    tags,
  })
  .input(withCompanyId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealResource) }))
  .handler(async ({ input, context }) => ({
    data: await companyDeals({ ...input, viewer: viewerFromContext(context) }),
  }))

const privateListCompanyTasksAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/tasks",
    summary: "Open and done tasks across the company's visible deals",
    tags,
  })
  .input(withCompanyId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealTaskResource) }))
  .handler(async ({ input, context }) => {
    await companyService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    return {
      data: await dealTaskService.listForDealsOf({
        workspaceId: input.workspaceId,
        parent: { companyId: input.id },
        viewer: viewerFromContext(context),
        limit: input.limit,
      }),
    }
  })

const privateListCompanyConversationsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/conversations",
    summary: "DM conversations of the company's contacts",
    tags,
  })
  .input(withCompanyId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(conversationSummaryResource) }))
  .handler(async ({ input }) => {
    await companyService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    const contactIds = await companyService.listContactIds({
      workspaceId: input.workspaceId,
      companyId: input.id,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    return {
      data: await conversationSummaries({
        workspaceId: input.workspaceId,
        contactIds,
      }),
    }
  })

const privateListCompanySubmissionsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/submissions",
    summary: "Questionnaire submissions of the company's contacts",
    tags,
  })
  .input(withCompanyId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(submissionSummaryResource) }))
  .handler(async ({ input }) => {
    await companyService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    const contactIds = await companyService.listContactIds({
      workspaceId: input.workspaceId,
      companyId: input.id,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    return {
      data: await questionnaireSubmissionService.listByContactIds({
        workspaceId: input.workspaceId,
        contactIds,
        limit: input.limit,
      }),
    }
  })

const privateGetCompanyTimelineAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/timeline",
    summary: "Merged timeline of a company (keyset paged)",
    tags,
  })
  .input(withCompanyId.and(timelineQuery))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(timelinePageResource)
  .handler(
    async ({ input, context }) =>
      await crmTimelineService.forCompany({
        workspaceId: input.workspaceId,
        companyId: input.id,
        kinds: input.kinds,
        cursor: input.cursor,
        limit: input.limit,
        viewer: viewerFromContext(context),
        accessScope: await requireContactPermissionScope(input.workspaceId),
      }),
  )

const privateListCompanyActivitiesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/activities",
    summary: "Change log of a company",
    tags,
  })
  .input(withCompanyId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(companyActivityResource) }))
  .handler(async ({ input }) => {
    await companyService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    return {
      data: await companyActivityService.list({
        workspaceId: input.workspaceId,
        companyId: input.id,
        limit: input.limit,
      }),
    }
  })

const privateListCompanyNotesAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/companies/{id}/notes",
    summary: "Notes on a company",
    tags,
  })
  .input(withCompanyId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(companyNoteResource) }))
  .handler(async ({ input }) => ({
    data: await companyNoteService.list({
      workspaceId: input.workspaceId,
      companyId: input.id,
      limit: input.limit,
    }),
  }))

const privateCreateCompanyNoteAPI = authorizedAPI
  .route({
    method: "POST",
    path: "/workspaces/{workspaceId}/companies/{id}/notes",
    summary: "Add a note to a company",
    tags,
  })
  .input(withCompanyId.and(noteBody))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(companyNoteResource)
  .handler(
    async ({ input, context }) =>
      await companyNoteService.create({
        workspaceId: input.workspaceId,
        companyId: input.id,
        text: input.text,
        createdById: context.user.id,
      }),
  )

const privateUpdateCompanyNoteAPI = authorizedAPI
  .route({
    method: "PUT",
    path: "/workspaces/{workspaceId}/companies/{id}/notes/{noteId}",
    summary: "Edit a company note",
    tags,
  })
  .input(withNoteId.and(noteBody))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(companyNoteResource)
  .handler(
    async ({ input }) =>
      await companyNoteService.update({
        workspaceId: input.workspaceId,
        companyId: input.id,
        noteId: input.noteId,
        text: input.text,
      }),
  )

const privateDeleteCompanyNoteAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/companies/{id}/notes/{noteId}",
    summary: "Delete a company note",
    tags,
  })
  .input(withNoteId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .handler(async ({ input, context }) => {
    await companyNoteService.delete({
      workspaceId: input.workspaceId,
      companyId: input.id,
      noteId: input.noteId,
      actorId: context.user.id,
    })
  })

const privateUnlinkCompanyContactAPI = authorizedAPI
  .route({
    method: "DELETE",
    path: "/workspaces/{workspaceId}/companies/{id}/contacts/{contactId}",
    summary: "Remove a contact from the company",
    tags,
  })
  .input(withCompanyId.and(z.object({ contactId: zodBigintAsString() })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .handler(async ({ input, context }) => {
    await companyService.findOrFail({
      workspaceId: input.workspaceId,
      id: input.id,
    })
    // the caller must be allowed to open the contact it unlinks
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: await requireContactPermissionScope(input.workspaceId),
    })
    // pinned to THIS company: a contact that moved elsewhere in between is a 409, never a silent detach
    await companyService.assignContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      companyId: null,
      expectedCompanyId: input.id,
      actorId: context.user.id,
    })
  })

// ---- contact ---------------------------------------------------------------

const privateGetContactTimelineAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/timeline",
    summary: "Merged timeline of a contact (keyset paged)",
    tags,
  })
  .input(withContactId.and(timelineQuery))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(timelinePageResource)
  .handler(async ({ input, context }) => {
    const scope = await requireContactPermissionScope(input.workspaceId)
    return await crmTimelineService.forContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      kinds: input.kinds,
      cursor: input.cursor,
      limit: input.limit,
      viewer: viewerFromContext(context),
      accessScope: scope,
    })
  })

const privateListContactSubmissionsAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/submissions",
    summary: "Questionnaire submissions of a contact",
    tags,
  })
  .input(withContactId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(submissionSummaryResource) }))
  .handler(async ({ input }) => {
    const scope = await requireContactPermissionScope(input.workspaceId)
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: scope,
    })
    return {
      data: await questionnaireSubmissionService.listByContactIds({
        workspaceId: input.workspaceId,
        contactIds: [input.contactId],
        limit: input.limit,
      }),
    }
  })

const privateListContactTasksAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/tasks",
    summary: "Tasks across the contact's visible deals",
    tags,
  })
  .input(withContactId.and(z.object({ limit: limitField })))
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(z.object({ data: z.array(dealTaskResource) }))
  .handler(async ({ input, context }) => {
    const scope = await requireContactPermissionScope(input.workspaceId)
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: scope,
    })
    return {
      data: await dealTaskService.listForDealsOf({
        workspaceId: input.workspaceId,
        parent: { contactId: input.contactId },
        viewer: viewerFromContext(context),
        limit: input.limit,
      }),
    }
  })

const privateGetContactConversationAPI = authorizedAPI
  .route({
    method: "GET",
    path: "/workspaces/{workspaceId}/contacts/{contactId}/conversation",
    summary: "The contact's DM conversation, if any",
    tags,
  })
  .input(withContactId)
  .use(contactsAccessAuthorizedMiddleware, (input) => input.workspaceId)
  .output(conversationSummaryResource.nullable())
  .handler(async ({ input }) => {
    const scope = await requireContactPermissionScope(input.workspaceId)
    await crmTimelineService.assertContact({
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      accessScope: scope,
    })
    const [row] = await conversationSummaries({
      workspaceId: input.workspaceId,
      contactIds: [input.contactId],
    })
    return row ?? null
  })

export const privateCrmAPI = {
  privateGetCompanyMetricsAPI,
  privateListCompanyDealsAPI,
  privateListCompanyTasksAPI,
  privateListCompanyConversationsAPI,
  privateListCompanySubmissionsAPI,
  privateGetCompanyTimelineAPI,
  privateListCompanyActivitiesAPI,
  privateListCompanyNotesAPI,
  privateCreateCompanyNoteAPI,
  privateUpdateCompanyNoteAPI,
  privateDeleteCompanyNoteAPI,
  privateUnlinkCompanyContactAPI,
  privateGetContactTimelineAPI,
  privateListContactSubmissionsAPI,
  privateListContactTasksAPI,
  privateGetContactConversationAPI,
}
