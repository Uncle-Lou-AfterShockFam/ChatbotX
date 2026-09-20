import { describe, expect, test } from "vitest"

// The public `delivery-status` route (apps/builder) enqueues its input
// verbatim as the `messageStatus` job payload, and the worker reads
// `payload.messageId` + the handler's `contact.sourceId` to find the message
// and its conversation. These tests pin the handler to that contract: the
// s158 live run found every 204-accepted status dying as a ZodError because
// this schema named the id `messageSourceId`, and even a renamed id could not
// land because the handler returned an empty recipient identity.
// Validation runs before the promise is built, so a bad payload THROWS.

const { handleMessageStatus } = await import(
  "../src/handlers/message/outgoing-message"
)

const ctx = { auth: { signingSecret: "secret" } } as never

const job = (payload: unknown) =>
  ({
    integrationType: "api",
    integrationIdentifier: "inbox-1",
    payload,
  }) as never

describe("api handleMessageStatus", () => {
  test("maps the public route payload onto the worker contract", async () => {
    const result = await handleMessageStatus({
      ctx,
      data: job({
        messageId: "msg:57",
        status: "delivered",
        timestamp: "2026-09-20T05:50:06.000Z",
        contact: { sourceId: "+15550000001" },
      }),
    })

    expect(result).toEqual({
      message: {
        sourceId: "msg:57",
        messageType: "outgoing",
        contentType: "text",
        contentAttributes: { deliveryStatus: "delivered" },
      },
      contact: { sourceId: "+15550000001" },
      postbackAction: null,
      quickReplyAction: null,
      ref: null,
    })
  })

  test("carries a failed status with its error untouched in the status field", async () => {
    const result = await handleMessageStatus({
      ctx,
      data: job({
        messageId: "hook:12",
        status: "failed",
        timestamp: "2026-09-20T05:50:06.000Z",
        error: { reason: "stop-reply" },
        contact: { sourceId: "+15550000002" },
      }),
    })
    expect(result?.message.contentAttributes).toEqual({
      deliveryStatus: "failed",
    })
    expect(result?.contact).toEqual({ sourceId: "+15550000002" })
  })

  test("rejects the pre-fix shape (`messageSourceId`) instead of silently mapping it", () => {
    expect(() =>
      handleMessageStatus({
        ctx,
        data: job({
          messageSourceId: "msg:57",
          status: "delivered",
          contact: { sourceId: "+15550000001" },
        }),
      }),
    ).toThrow()
  })

  test("rejects a status with no recipient identity (fail closed)", () => {
    expect(() =>
      handleMessageStatus({
        ctx,
        data: job({ messageId: "msg:57", status: "delivered" }),
      }),
    ).toThrow()
    expect(() =>
      handleMessageStatus({
        ctx,
        data: job({
          messageId: "msg:57",
          status: "delivered",
          contact: { sourceId: "" },
        }),
      }),
    ).toThrow()
  })

  test("rejects an empty message id and a non-object payload", () => {
    expect(() =>
      handleMessageStatus({
        ctx,
        data: job({
          messageId: "",
          status: "delivered",
          contact: { sourceId: "+15550000001" },
        }),
      }),
    ).toThrow()
    expect(() => handleMessageStatus({ ctx, data: job(null) })).toThrow()
    expect(() => handleMessageStatus({ ctx, data: job("msg:57") })).toThrow()
  })
})
