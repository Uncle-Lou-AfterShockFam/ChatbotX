import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * s207b: the webhook-endpoint upgrade (an endpoint subscribed before the
 * checkout events gets them in place, then the version is CAS-bumped) and
 * the workspace default invoice method. Stripe and the database are mocked.
 */

const m = vi.hoisted(() => ({
  endpointUpdate: vi.fn(),
  updates: [] as Record<string, unknown>[],
  returningRow: null as Record<string, unknown> | null,
  audit: vi.fn(),
}))

vi.mock("@chatbotx.io/database/client", () => {
  const chain = {
    set: (v: Record<string, unknown>) => {
      m.updates.push(v)
      return chain
    },
    where: () => chain,
    returning: () => Promise.resolve(m.returningRow ? [m.returningRow] : []),
    // biome-ignore lint/suspicious/noThenProperty: awaited query-builder stub
    then: (resolve: (v: unknown) => unknown) => resolve(undefined),
  }
  return {
    db: { update: () => chain },
    and: (...c: unknown[]) => ({ and: c }),
    eq: (_f: unknown, v: unknown) => ({ eq: v }),
    lt: (_f: unknown, v: unknown) => ({ lt: v }),
    isNull: () => ({ isNull: true }),
    sql: () => ({}),
  }
})
vi.mock("../src/integration-stripe/client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/integration-stripe/client")
  >()),
  createStripeClient: () => ({
    webhookEndpoints: { update: (...a: unknown[]) => m.endpointUpdate(...a) },
  }),
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: (...a: unknown[]) => m.audit(...a),
}))

const { integrationStripeService } = await import(
  "../src/integration-stripe/service"
)
const { STRIPE_WEBHOOK_EVENTS, STRIPE_WEBHOOK_EVENTS_VERSION } = await import(
  "../src/integration-stripe/client"
)

const credentials = (extra: Record<string, unknown> = {}) => ({
  integrationId: "77",
  workspaceId: "11",
  accountId: "acct_1",
  livemode: false,
  defaultMethod: "stripeInvoice" as const,
  webhookEndpointId: "we_1",
  webhookEventsVersion: 1,
  auth: {
    secretKey: ["sk", "test", "unitTestKey0123456789"].join("_"),
    webhookSecret: "whsec_unitTestSecret0123456789abcdef",
  },
  ...extra,
})

beforeEach(() => {
  vi.clearAllMocks()
  m.updates = []
  m.returningRow = null
  m.endpointUpdate.mockResolvedValue({ id: "we_1" })
})

describe("STRIPE_WEBHOOK_EVENTS v2", () => {
  test("carries every checkout event the webhook handles, and the version moved", () => {
    expect(STRIPE_WEBHOOK_EVENTS).toEqual(
      expect.arrayContaining([
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.async_payment_failed",
        "invoice.paid",
        "charge.refunded",
      ]),
    )
    expect(STRIPE_WEBHOOK_EVENTS_VERSION).toBe(2)
  })
})

describe("ensureWebhookEvents", () => {
  test("an endpoint on version 1 is updated in place with the FULL list, then the version is bumped", async () => {
    const creds = credentials()
    await integrationStripeService.ensureWebhookEvents(creds)
    expect(m.endpointUpdate).toHaveBeenCalledWith("we_1", {
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
    })
    expect(m.updates).toEqual([
      expect.objectContaining({ webhookEventsVersion: 2 }),
    ])
    expect(creds.webhookEventsVersion).toBe(2)
  })

  test("a current endpoint is left alone (no Stripe call, no write)", async () => {
    await integrationStripeService.ensureWebhookEvents(
      credentials({ webhookEventsVersion: 2 }),
    )
    expect(m.endpointUpdate).not.toHaveBeenCalled()
    expect(m.updates).toEqual([])
  })

  test("no endpoint id -> a validation error asking to reconnect", async () => {
    const error = await integrationStripeService
      .ensureWebhookEvents(credentials({ webhookEndpointId: null }))
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "validation" })
    expect(m.endpointUpdate).not.toHaveBeenCalled()
  })

  test("a Stripe failure bumps nothing (the next call retries the upgrade)", async () => {
    m.endpointUpdate.mockRejectedValue(new Error("No such webhook endpoint"))
    const creds = credentials()
    const error = await integrationStripeService
      .ensureWebhookEvents(creds)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "validation" })
    expect(m.updates).toEqual([])
    expect(creds.webhookEventsVersion).toBe(1)
  })
})

describe("setDefaultMethod", () => {
  test("stores the method and audits it", async () => {
    m.returningRow = {
      id: "1",
      integrationId: "77",
      accountId: "acct_1",
      accountName: null,
      livemode: false,
      keyLast4: "6789",
      webhookEndpointId: "we_1",
      defaultMethod: "stripeCheckout",
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    const summary = await integrationStripeService.setDefaultMethod({
      workspaceId: "11",
      method: "stripeCheckout",
    })
    expect(m.updates[0]).toMatchObject({ defaultMethod: "stripeCheckout" })
    expect(summary.defaultMethod).toBe("stripeCheckout")
    expect(summary).not.toHaveProperty("auth")
    expect(m.audit).toHaveBeenCalledTimes(1)
  })

  test("Stripe not connected -> credentialMissing", async () => {
    const error = await integrationStripeService
      .setDefaultMethod({ workspaceId: "11", method: "stripeInvoice" })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: "credentialMissing" })
  })

  test.each([
    ["default (a request value, not a setting)", { method: "default" }],
    ["an unknown method", { method: "paypal" }],
    ["null", { method: null }],
    ["an unknown key", { method: "stripeInvoice", extra: 1 }],
    ["a non-id workspace", { method: "stripeInvoice", workspaceId: "ws" }],
  ])("%s is rejected before any write", async (_l, patch) => {
    await expect(
      integrationStripeService.setDefaultMethod({
        workspaceId: "11",
        ...patch,
      } as never),
    ).rejects.toThrow()
    expect(m.updates).toEqual([])
  })
})
