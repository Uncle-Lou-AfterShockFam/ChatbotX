import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * stripeCheckout (s207b): the `/pay/<token>` visit and the checkout void
 * helpers. The database is ONE in-memory invoice row whose UPDATE predicates
 * (and / eq / isNull on real drizzle columns) are evaluated for real, so the
 * generation CAS and the record CAS behave as in Postgres for a single row.
 * Stripe is a fake that honours Idempotency-Keys (same key + same body = the
 * same session; same key + another body = an error, as Stripe does).
 * What is pinned: at most one live session per invoice, a racer of the same
 * generation joins the same session, a completed session is never replaced,
 * and a session minted for a row voided meanwhile is expired.
 */

const WS = "11"
const INTEGRATION = "77"
const TOKEN = "0123456789ABCDEFGHIJKL"
const JUST_PAID = /just paid/

type Row = Record<string, unknown>

const m = vi.hoisted(() => {
  const state = {
    row: null as Row | null,
    lines: [] as Row[],
    reads: 0,
    /** Runs once, right before the next `sessions.create` resolves. */
    beforeCreateResolves: null as (() => void) | null,
  }
  type Cond =
    | { and: Cond[] }
    | { col: string; eq: unknown }
    | { col: string; isNull: true }
    | undefined
  const matches = (row: Row, cond: Cond): boolean => {
    if (!cond) {
      return true
    }
    if ("and" in cond) {
      return cond.and.every((c) => matches(row, c))
    }
    if ("isNull" in cond) {
      return row[cond.col] == null
    }
    const value = row[cond.col]
    return value instanceof Date && cond.eq instanceof Date
      ? value.getTime() === cond.eq.getTime()
      : value === cond.eq
  }
  const db = {
    query: {
      invoiceModel: {
        findFirst: (args: { where: { payToken: string } }) => {
          state.reads += 1
          const row = state.row
          if (!row || row.payToken !== args.where.payToken) {
            return Promise.resolve(undefined)
          }
          return Promise.resolve({ ...row, lineItems: state.lines })
        },
      },
    },
    update: () => {
      let pending: Row = {}
      let cond: Cond
      const chain = {
        set: (v: Row) => {
          pending = v
          return chain
        },
        where: (c: Cond) => {
          cond = c
          return chain
        },
        returning: () => {
          if (state.row && matches(state.row, cond)) {
            state.row = { ...state.row, ...pending }
            return Promise.resolve([{ ...state.row }])
          }
          return Promise.resolve([])
        },
      }
      return chain
    },
  }

  type Session = Row & { id: string; status: string }
  const stripe = {
    sessions: new Map<string, Session>(),
    keys: new Map<string, { body: string; id: string }>(),
    creates: 0,
    expires: 0,
    counter: 0,
  }
  const sessionsApi = {
    create: async (params: Row, opts: { idempotencyKey: string }) => {
      const body = JSON.stringify(params)
      await Promise.resolve()
      const hook = state.beforeCreateResolves
      state.beforeCreateResolves = null
      hook?.()
      // Stripe serialises one key (a concurrent duplicate gets a 409 the SDK
      // retries), so the key is looked up only once the request "lands".
      const seen = stripe.keys.get(opts.idempotencyKey)
      if (seen) {
        if (seen.body !== body) {
          throw new Error("idempotency key reused with different parameters")
        }
        return { ...stripe.sessions.get(seen.id) }
      }
      stripe.creates += 1
      stripe.counter += 1
      const id = `cs_test_${stripe.counter}`
      const lines = params.line_items as {
        quantity: number
        price_data: { unit_amount: number; currency: string }
      }[]
      const session: Session = {
        id,
        status: "open",
        url: `https://checkout.stripe.com/c/pay/${id}`,
        expires_at: params.expires_at,
        amount_total:
          m.amountOverride ??
          lines.reduce((s, l) => s + l.quantity * l.price_data.unit_amount, 0),
        currency: lines[0]?.price_data.currency,
        params,
      }
      stripe.sessions.set(id, session)
      stripe.keys.set(opts.idempotencyKey, { body, id })
      return { ...session }
    },
    retrieve: (id: string) => {
      const session = stripe.sessions.get(id)
      if (!session) {
        return Promise.reject(new Error(`No such checkout session: ${id}`))
      }
      return Promise.resolve({ ...session })
    },
    expire: (id: string) => {
      const session = stripe.sessions.get(id)
      if (session?.status !== "open") {
        return Promise.reject(
          new Error(
            "Only Checkout Sessions with a status of open can be expired",
          ),
        )
      }
      stripe.expires += 1
      session.status = "expired"
      return Promise.resolve({ ...session })
    },
  }
  return {
    state,
    db,
    stripe,
    sessionsApi,
    amountOverride: null as number | null,
    credentials: vi.fn(),
    ensureEvents: vi.fn(),
    ensureCustomer: vi.fn(),
    appUrl: vi.fn(),
    loggerError: vi.fn(),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.db,
  and: (...c: unknown[]) => ({ and: c }),
  eq: (f: { name: string }, v: unknown) => ({ col: f.name, eq: v }),
  isNull: (f: { name: string }) => ({ col: f.name, isNull: true }),
}))
vi.mock("../src/integration-stripe/client", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/integration-stripe/client")
  >()),
  createStripeClient: () => ({ checkout: { sessions: m.sessionsApi } }),
}))
vi.mock("../src/integration-stripe/service", () => ({
  integrationStripeService: {
    credentialsByWorkspaceId: (...a: unknown[]) => m.credentials(...a),
    ensureWebhookEvents: (...a: unknown[]) => m.ensureEvents(...a),
  },
}))
vi.mock("../src/invoice/stripe-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/invoice/stripe-provider")>()),
  ensureCustomer: (...a: unknown[]) => m.ensureCustomer(...a),
}))
vi.mock("../src/platform/settings", () => ({
  resolveWorkspaceAppUrl: (...a: unknown[]) => m.appUrl(...a),
}))
vi.mock("../src/logger", () => ({
  logger: { warn: vi.fn(), error: m.loggerError, info: vi.fn() },
}))

const {
  visitCheckout,
  prepareCheckoutInvoice,
  assertCheckoutNotPaid,
  expireCheckoutAfterVoid,
  isInvoicePayToken,
  CHECKOUT_SESSION_TTL_MS,
} = await import("../src/invoice/checkout-provider")
const { InvoiceProviderError } = await import("../src/invoice/stripe-provider")

const CREDENTIALS = {
  integrationId: INTEGRATION,
  workspaceId: WS,
  accountId: "acct_1",
  livemode: false,
  defaultMethod: "stripeCheckout" as const,
  webhookEndpointId: "we_1",
  webhookEventsVersion: 2,
  auth: {
    secretKey: ["sk", "test", "unitTestKey0123456789"].join("_"),
    webhookSecret: "whsec_unitTestSecret0123456789abcdef",
  },
}

const openRow = (extra: Row = {}): Row => ({
  id: "501",
  workspaceId: WS,
  contactId: "21",
  number: 4,
  status: "open",
  method: "stripeCheckout",
  currency: "USD",
  total: "12.50",
  integrationId: INTEGRATION,
  providerAccountId: "acct_1",
  providerCustomerId: "cus_1",
  providerInvoiceId: null,
  hostedUrl: `https://chat.example.org/pay/${TOKEN}`,
  payToken: TOKEN,
  checkoutSessionId: null,
  checkoutGeneration: 0,
  checkoutMintedAt: null,
  ...extra,
})

const liveSessions = () =>
  [...m.stripe.sessions.values()].filter((s) => s.status === "open")

beforeEach(() => {
  vi.clearAllMocks()
  m.state.row = openRow()
  m.state.lines = [
    { position: 0, description: "Consult", quantity: 2, unitAmount: "5.00" },
    { position: 1, description: "Report", quantity: 1, unitAmount: "2.50" },
  ]
  m.state.reads = 0
  m.state.beforeCreateResolves = null
  m.stripe.sessions.clear()
  m.stripe.keys.clear()
  m.stripe.creates = 0
  m.stripe.expires = 0
  m.stripe.counter = 0
  m.amountOverride = null
  m.credentials.mockResolvedValue(CREDENTIALS)
})

describe("visitCheckout: token and row gates", () => {
  test.each([
    ["too short", "abc"],
    ["23 characters", `${TOKEN}Z`],
    ["a non-base62 character", "0123456789ABCDEFGHIJK-"],
    ["empty", ""],
  ])("a malformed token (%s) is not found without a database read", async (_l, token) => {
    expect(await visitCheckout(token)).toEqual({ kind: "notFound" })
    expect(m.state.reads).toBe(0)
  })

  test("an unknown token is not found", async () => {
    expect(await visitCheckout("ZZZZZZZZZZZZZZZZZZZZZZ")).toEqual({
      kind: "notFound",
    })
  })

  test("a stripeInvoice row behind a token is not found (never a checkout)", async () => {
    m.state.row = openRow({ method: "stripeInvoice" })
    expect(await visitCheckout(TOKEN)).toEqual({ kind: "notFound" })
    expect(m.stripe.creates).toBe(0)
  })

  test.each([
    ["paid", "paid"],
    ["refunded", "paid"],
    ["void", "closed"],
    ["uncollectible", "closed"],
  ])("a %s invoice answers %s and mints nothing", async (status, kind) => {
    m.state.row = openRow({ status })
    expect((await visitCheckout(TOKEN)).kind).toBe(kind)
    expect(m.stripe.creates).toBe(0)
  })

  test.each([
    ["Stripe disconnected", null],
    ["another integration", { ...CREDENTIALS, integrationId: "78" }],
    ["another Stripe account", { ...CREDENTIALS, accountId: "acct_2" }],
  ])("%s -> unavailable, nothing minted", async (_l, credentials) => {
    m.credentials.mockResolvedValue(credentials)
    expect((await visitCheckout(TOKEN)).kind).toBe("unavailable")
    expect(m.stripe.creates).toBe(0)
  })
})

describe("visitCheckout: minting and reuse", () => {
  test("the first visit claims generation 1, mints one session and records it", async () => {
    const before = Date.now()
    const visit = await visitCheckout(TOKEN)
    expect(visit).toMatchObject({
      kind: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_test_1",
    })
    expect(m.state.row).toMatchObject({
      checkoutGeneration: 1,
      checkoutSessionId: "cs_test_1",
    })
    expect([...m.stripe.keys.keys()]).toEqual(["hub-inv-501-cs-1"])
    const params = m.stripe.sessions.get("cs_test_1")?.params as Row
    const mintedAt = (m.state.row?.checkoutMintedAt as Date).getTime()
    expect(mintedAt).toBeGreaterThanOrEqual(before)
    expect(params).toMatchObject({
      mode: "payment",
      customer: "cus_1",
      client_reference_id: "501",
      expires_at: Math.floor((mintedAt + CHECKOUT_SESSION_TTL_MS) / 1000),
      success_url: `https://chat.example.org/pay/${TOKEN}?done=1`,
      metadata: { hub_invoice_id: "501", hub_workspace_id: WS },
      payment_intent_data: {
        metadata: { hub_invoice_id: "501", hub_workspace_id: WS },
      },
      line_items: [
        {
          quantity: 2,
          price_data: {
            currency: "usd",
            unit_amount: 500,
            product_data: { name: "Consult" },
          },
        },
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 250,
            product_data: { name: "Report" },
          },
        },
      ],
    })
    // One-time payment: the card is never saved for later.
    expect(params).not.toHaveProperty("setup_future_usage")
    expect(params.payment_intent_data).not.toHaveProperty("setup_future_usage")
  })

  test("a second visit reuses the live session: no create, no expire", async () => {
    await visitCheckout(TOKEN)
    const again = await visitCheckout(TOKEN)
    expect(again).toMatchObject({ kind: "redirect" })
    expect(m.stripe.creates).toBe(1)
    expect(m.stripe.expires).toBe(0)
  })

  test("a session under 30 min from expiry is expired FIRST, then generation 2 mints a new one", async () => {
    await visitCheckout(TOKEN)
    const first = m.stripe.sessions.get("cs_test_1") as Row
    first.expires_at = Math.floor((Date.now() + 29 * 60_000) / 1000)
    const visit = await visitCheckout(TOKEN)
    expect(visit).toMatchObject({
      kind: "redirect",
      url: expect.stringContaining("cs_test_2"),
    })
    expect(m.stripe.sessions.get("cs_test_1")?.status).toBe("expired")
    expect(m.state.row).toMatchObject({
      checkoutGeneration: 2,
      checkoutSessionId: "cs_test_2",
    })
    expect(liveSessions().map((s) => s.id)).toEqual(["cs_test_2"])
  })

  test("a session Stripe already expired is replaced by the next generation", async () => {
    await visitCheckout(TOKEN)
    ;(m.stripe.sessions.get("cs_test_1") as Row).status = "expired"
    await visitCheckout(TOKEN)
    expect(m.state.row?.checkoutSessionId).toBe("cs_test_2")
    expect(liveSessions()).toHaveLength(1)
  })

  test("a COMPLETED session (paid, webhook pending) answers processing and is never replaced", async () => {
    await visitCheckout(TOKEN)
    ;(m.stripe.sessions.get("cs_test_1") as Row).status = "complete"
    const visit = await visitCheckout(TOKEN)
    expect(visit.kind).toBe("processing")
    expect(m.stripe.creates).toBe(1)
    expect(m.state.row?.checkoutGeneration).toBe(1)
  })

  test("a session that completes while being expired answers processing, no new session", async () => {
    await visitCheckout(TOKEN)
    const first = m.stripe.sessions.get("cs_test_1") as Row
    first.expires_at = Math.floor((Date.now() + 60_000) / 1000)
    const realExpire = m.sessionsApi.expire
    m.sessionsApi.expire = (id: string) => {
      ;(m.stripe.sessions.get(id) as Row).status = "complete"
      return realExpire(id)
    }
    try {
      expect((await visitCheckout(TOKEN)).kind).toBe("processing")
    } finally {
      m.sessionsApi.expire = realExpire
    }
    expect(m.stripe.creates).toBe(1)
  })

  test("a young pending generation (claimed, never recorded) is JOINED through the same key", async () => {
    const mintedAt = new Date(Date.now() - 60_000)
    m.state.row = openRow({ checkoutGeneration: 3, checkoutMintedAt: mintedAt })
    const visit = await visitCheckout(TOKEN)
    expect(visit.kind).toBe("redirect")
    expect([...m.stripe.keys.keys()]).toEqual(["hub-inv-501-cs-3"])
    expect(m.state.row?.checkoutGeneration).toBe(3)
  })

  test("a STALE pending generation (> 10 min) is abandoned for a fresh one", async () => {
    m.state.row = openRow({
      checkoutGeneration: 3,
      checkoutMintedAt: new Date(Date.now() - 11 * 60_000),
    })
    await visitCheckout(TOKEN)
    expect([...m.stripe.keys.keys()]).toEqual(["hub-inv-501-cs-4"])
    expect(m.state.row?.checkoutGeneration).toBe(4)
  })

  test("a session total that is not the hub total is expired and the visit fails", async () => {
    m.amountOverride = 1
    const error = await visitCheckout(TOKEN).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(m.stripe.sessions.get("cs_test_1")?.status).toBe("expired")
    expect(m.state.row?.checkoutSessionId).toBeNull()
  })
})

describe("visitCheckout: races", () => {
  test("two concurrent first visits land on the SAME session; one Stripe object, one live", async () => {
    const [a, b] = await Promise.all([
      visitCheckout(TOKEN),
      visitCheckout(TOKEN),
    ])
    expect(a).toMatchObject({ kind: "redirect" })
    expect(b).toMatchObject({ kind: "redirect" })
    expect((a as { url: string }).url).toBe((b as { url: string }).url)
    expect(m.stripe.creates).toBe(1)
    expect(liveSessions()).toHaveLength(1)
    expect(m.state.row).toMatchObject({
      checkoutGeneration: 1,
      checkoutSessionId: "cs_test_1",
    })
  })

  test("five concurrent visits on an expiring session still leave exactly one live session", async () => {
    await visitCheckout(TOKEN)
    ;(m.stripe.sessions.get("cs_test_1") as Row).expires_at = Math.floor(
      (Date.now() + 60_000) / 1000,
    )
    const visits = await Promise.all(
      Array.from({ length: 5 }, () => visitCheckout(TOKEN)),
    )
    const urls = new Set(
      visits.map((v) => (v.kind === "redirect" ? v.url : v.kind)),
    )
    expect(urls.size).toBe(1)
    expect(liveSessions()).toHaveLength(1)
    expect(liveSessions()[0]?.id).toBe(m.state.row?.checkoutSessionId)
  })

  test("voided while the visit was minting: the new session is expired, the visit answers closed", async () => {
    m.state.beforeCreateResolves = () => {
      m.state.row = { ...(m.state.row as Row), status: "void" }
    }
    const visit = await visitCheckout(TOKEN)
    expect(visit.kind).toBe("closed")
    expect(m.stripe.sessions.get("cs_test_1")?.status).toBe("expired")
    expect(liveSessions()).toHaveLength(0)
    expect(m.state.row?.checkoutSessionId).toBeNull()
  })
})

describe("prepareCheckoutInvoice", () => {
  beforeEach(() => {
    m.ensureCustomer.mockResolvedValue("cus_9")
    m.appUrl.mockResolvedValue("https://chat.example.org")
    m.ensureEvents.mockResolvedValue(undefined)
  })

  test("upgrades the webhook, makes the customer, mints a 22-char token and the pay URL", async () => {
    const draft = openRow({ status: "draft", payToken: null, hostedUrl: null })
    const prepared = await prepareCheckoutInvoice({
      credentials: CREDENTIALS,
      invoice: draft as never,
    })
    expect(m.ensureEvents).toHaveBeenCalledWith(CREDENTIALS)
    expect(isInvoicePayToken(prepared.payToken)).toBe(true)
    expect(prepared).toEqual({
      providerCustomerId: "cus_9",
      payToken: prepared.payToken,
      hostedUrl: `https://chat.example.org/pay/${prepared.payToken}`,
    })
    const other = await prepareCheckoutInvoice({
      credentials: CREDENTIALS,
      invoice: draft as never,
    })
    expect(other.payToken).not.toBe(prepared.payToken)
  })

  test("a webhook upgrade failure is a retryable provider error; no customer is made", async () => {
    m.ensureEvents.mockRejectedValue(new Error("Stripe down"))
    const error = await prepareCheckoutInvoice({
      credentials: CREDENTIALS,
      invoice: openRow({ status: "draft" }) as never,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvoiceProviderError)
    expect(error).toMatchObject({ retryable: true })
    expect(m.ensureCustomer).not.toHaveBeenCalled()
  })

  test.each([
    ["zero", "0.00"],
    ["over Stripe's max", "1000000.00"],
  ])("a %s total is refused before any Stripe call", async (_l, total) => {
    const error = await prepareCheckoutInvoice({
      credentials: CREDENTIALS,
      invoice: openRow({ status: "draft", total }) as never,
    }).catch((e: unknown) => e)
    expect(error).toMatchObject({ retryable: false })
    expect(m.ensureEvents).not.toHaveBeenCalled()
  })
})

describe("checkout void helpers", () => {
  test("assertCheckoutNotPaid refuses a completed session, allows open or none", async () => {
    await visitCheckout(TOKEN)
    const row = m.state.row as never
    await expect(
      assertCheckoutNotPaid({ credentials: CREDENTIALS, invoice: row }),
    ).resolves.toBeUndefined()
    ;(m.stripe.sessions.get("cs_test_1") as Row).status = "complete"
    await expect(
      assertCheckoutNotPaid({ credentials: CREDENTIALS, invoice: row }),
    ).rejects.toThrow(JUST_PAID)
    await expect(
      assertCheckoutNotPaid({
        credentials: CREDENTIALS,
        invoice: openRow() as never,
      }),
    ).resolves.toBeUndefined()
  })

  test("expireCheckoutAfterVoid expires the open session; an expired one is fine; a completed one is logged", async () => {
    await visitCheckout(TOKEN)
    const row = m.state.row as never
    await expireCheckoutAfterVoid({ credentials: CREDENTIALS, invoice: row })
    expect(m.stripe.sessions.get("cs_test_1")?.status).toBe("expired")
    await expireCheckoutAfterVoid({ credentials: CREDENTIALS, invoice: row })
    ;(m.stripe.sessions.get("cs_test_1") as Row).status = "complete"
    await expireCheckoutAfterVoid({ credentials: CREDENTIALS, invoice: row })
    expect(m.loggerError).toHaveBeenCalledTimes(1)
  })
})
