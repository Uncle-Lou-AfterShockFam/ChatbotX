import {
  apiChannelOutboxService,
  normalizeAck,
  OUTBOX_MAX_PULL,
} from "@chatbotx.io/business"
import { incomingApiMessageSchema } from "@chatbotx.io/integration-api"
import { enqueueIntegrationJob } from "@chatbotx.io/worker-config"
import { z } from "zod"
import { logger } from "@/lib/log"
import { possibleErrorsOnCreatingResource } from "@/lib/orpc/orpc-error-helper"
import { assertApiNotRateLimited } from "@/lib/rate-limit/api-rate-limit"
import { channelApiTokenAPI } from "@/orpc"

const assertNotRateLimited = (inboxId: string): Promise<void> =>
  assertApiNotRateLimited({ scope: "channel-api-rate-limit", key: inboxId })

export const channelsPublicRouter = {
  sendMessage: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/messages",
      summary: "Send inbound message from your application",
      description:
        "`message.sourceId` is the idempotency key — sending the same value twice for the same contact does not create a duplicate message. Always send a stable id, never a random one per retry.",
      tags: ["API Channel"],
      successStatus: 202,
    })
    .input(incomingApiMessageSchema)
    .output(
      z.object({
        accepted: z.boolean(),
        messageSourceId: z.string(),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)

      await enqueueIntegrationJob({
        type: "incomingMessage",
        data: {
          integrationType: "api",
          integrationIdentifier: context.inbox.id,
          payload: input,
        },
      })

      return { accepted: true, messageSourceId: input.message.sourceId }
    }),

  typing: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/typing",
      summary: "Report contact typing",
      description:
        "Records a typing indicator for the contact. Currently accepted and logged only; no downstream effect yet.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        contact: z
          .object({
            sourceId: z.string().min(1).describe("Contact id in your system."),
          })
          .describe("Contact who is typing."),
        typing: z
          .boolean()
          .describe("Whether the contact started or stopped typing."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)

      // No downstream consumer for inbound "contact is typing" today (no
      // matching IntegrationJobAction/worker handler) — accepted and
      // acknowledged, not yet relayed anywhere. Revisit if/when the inbox UI
      // needs to reflect contact-side typing state.
      logger.debug(
        { inboxId: context.inbox.id, sourceId: input.contact.sourceId },
        "Received contact typing notification",
      )
    }),

  markRead: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/read",
      summary: "Report contact read outbound messages",
      description:
        "Marks the conversation as read up to this contact, mirroring a read receipt from the channel.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        contact: z
          .object({
            sourceId: z.string().min(1).describe("Contact id in your system."),
          })
          .describe("Contact who read the messages."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)

      await enqueueIntegrationJob({
        type: "contactMarkAsRead",
        data: {
          integrationType: "api",
          integrationIdentifier: context.inbox.id,
          sourceConversationId: input.contact.sourceId,
          payload: input,
        },
      })
    }),

  deliveryStatus: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/delivery-status",
      summary: "Report delivery status for outbound message",
      description:
        "`messageId` correlates to the id returned in the outbound callback response, if one was supplied. `contact.sourceId` is the recipient's identity on this channel (the same value used as `contact.sourceId` on inbound messages); the status is attached to that contact's conversation.",
      tags: ["API Channel"],
      successStatus: 204,
    })
    .input(
      z.object({
        messageId: z
          .string()
          .min(1)
          .describe(
            "Id of the message being reported on, echoed back from the outbound callback.",
          ),
        contact: z
          .object({
            sourceId: z
              .string()
              .min(1)
              .describe(
                "Recipient identity on this channel, identical to the inbound `contact.sourceId`.",
              ),
          })
          .describe("The contact the message was sent to."),
        status: z
          .enum(["delivered", "failed", "read"])
          .describe("Delivery outcome for the message."),
        timestamp: z.string().describe("When the status change occurred."),
        error: z
          .unknown()
          .optional()
          .describe("Provider error details, present when status is `failed`."),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)

      await enqueueIntegrationJob({
        type: "messageStatus",
        data: {
          integrationType: "api",
          integrationIdentifier: context.inbox.id,
          payload: input,
        },
      })
    }),

  outboxPull: channelApiTokenAPI
    .route({
      method: "GET",
      path: "/v1/channels/api/outbox",
      summary: "Lease queued outbound messages (pull delivery mode)",
      description:
        "For an inbox whose integration runs in `pull` delivery mode (no callback URL): leases up to `limit` queued outbound envelopes, oldest first, for 10 minutes. Each row carries the same `message_created` envelope a push-mode callback would have received. Answer every row with `POST /v1/channels/api/outbox/{id}/ack`; an unacked lease expires and the row is handed out again, so use the row id as your idempotency key.",
      tags: ["API Channel"],
    })
    .input(
      z.object({
        limit: z.coerce.number().int().min(1).max(OUTBOX_MAX_PULL).default(20),
      }),
    )
    .output(
      z.object({
        rows: z.array(
          z.object({
            id: z.string(),
            contactSourceId: z.string(),
            envelope: z.record(z.string(), z.unknown()),
            createdAt: z.string(),
            leaseExpiresAt: z.string(),
          }),
        ),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)
      const rows = await apiChannelOutboxService.pull({
        inboxId: context.inbox.id,
        limit: input.limit,
      })
      return {
        rows: rows.map((row) => ({
          id: row.id,
          contactSourceId: row.contactSourceId,
          envelope: row.envelope,
          createdAt: row.createdAt.toISOString(),
          leaseExpiresAt: (row.leaseExpiresAt ?? row.createdAt).toISOString(),
        })),
      }
    }),

  outboxAck: channelApiTokenAPI
    .route({
      method: "POST",
      path: "/v1/channels/api/outbox/{id}/ack",
      summary: "Settle a leased outbound message (pull delivery mode)",
      description:
        "The pull-mode twin of the callback response: `messageId` is your id for the queued send, a non-empty `reason` means you refused it (the hub marks the message failed with that reason), and `suppressed` together with a `messageId` is not a refusal (report it later as a failed delivery status). Acking a row that is already settled is a no-op.",
      tags: ["API Channel"],
      successStatus: 200,
    })
    .input(
      z.object({
        id: z.string().min(1),
        messageId: z.string().max(500).nullish(),
        reason: z.string().max(500).nullish(),
        warning: z.string().max(500).nullish(),
      }),
    )
    .output(
      z.object({
        outcome: z.enum(["acked", "refused", "already-settled", "not-found"]),
      }),
    )
    .errors(possibleErrorsOnCreatingResource)
    .handler(async ({ context, input }) => {
      await assertNotRateLimited(context.inbox.id)
      const { id, ...rest } = input
      const ack = normalizeAck(rest)
      const settled = await apiChannelOutboxService.ack({
        inboxId: context.inbox.id,
        id,
        ack,
      })
      if (settled.outcome === "refused") {
        // The same job a push-mode refusal ends in (`message:failed` + the
        // bulktext verdict on the contact), keyed by the outbox id the
        // message row carries as its channel id.
        const warning =
          typeof ack.warning === "string" && ack.warning !== ""
            ? `: ${ack.warning}`
            : ""
        await enqueueIntegrationJob({
          type: "messageStatus",
          data: {
            integrationType: "api",
            integrationIdentifier: context.inbox.id,
            payload: {
              messageId: `outbox:${id}`,
              contact: { sourceId: settled.contactSourceId },
              status: "failed",
              timestamp: new Date().toISOString(),
              error: `bulktext refused the send (${ack.reason})${warning}`,
            },
          },
        })
      }
      return { outcome: settled.outcome }
    }),

  me: channelApiTokenAPI
    .route({
      method: "GET",
      path: "/v1/channels/api/me",
      summary: "Verify token and echo connected inbox identity",
      description:
        "Use this to confirm a token is valid and discover which inbox and workspace it is scoped to.",
      tags: ["API Channel"],
    })
    .output(
      z.object({
        inboxId: z.string(),
        inboxName: z.string(),
        workspaceId: z.string(),
      }),
    )
    .handler(({ context }) => ({
      inboxId: context.inbox.id,
      inboxName: context.inbox.name,
      workspaceId: context.workspace.id,
    })),
}
