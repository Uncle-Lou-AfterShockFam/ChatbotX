import { and, db, eq, isNull } from "@chatbotx.io/database/client"
import {
  decimalStringToMinor,
  INVOICE_PAY_TOKEN_LENGTH,
} from "@chatbotx.io/database/partials"
import { invoiceModel } from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import { isBase62Token, mintBase62Token } from "@chatbotx.io/utils"
import { createStripeClient, type Stripe } from "../integration-stripe/client"
import {
  integrationStripeService,
  type StripeCredentials,
} from "../integration-stripe/service"
import { logger } from "../logger"
import { resolveWorkspaceAppUrl } from "../platform/settings"
import {
  ensureCustomer,
  InvoiceProviderError,
  STRIPE_MAX_AMOUNT_MINOR,
  wrapStripeError,
} from "./stripe-provider"

/**
 * stripeCheckout (s207b). The contact gets ONE stable hub link,
 * `/pay/<payToken>`, that lives as long as the invoice is open; each visit
 * reuses the invoice's live Checkout Session or mints the next one (Stripe
 * caps a session at 24 h). At most one session per invoice is ever payable:
 * the previous one is expired BEFORE the next generation is claimed, and the
 * claim is a CAS on `checkoutGeneration`. Racing visitors of one generation
 * replay the same Idempotency-Key with the same body (its expiry derives from
 * `checkoutMintedAt`), so Stripe hands them the same session. Other invoices
 * of the same contact are independent: each has its own link and session.
 */

/** A session is reused only while it has at least this long to live. */
export const CHECKOUT_REUSE_MIN_MS = 30 * 60_000
/** Session lifetime from the generation claim (Stripe allows at most 24 h). */
export const CHECKOUT_SESSION_TTL_MS = 23 * 60 * 60_000
/**
 * A claimed generation whose session was never recorded (the minting visit
 * crashed) is joined only while young; past this a fresh generation is
 * claimed. The abandoned session's URL never reached anyone.
 */
const PENDING_MINT_JOIN_MS = 10 * 60_000
const MAX_VISIT_ROUNDS = 4

export const isInvoicePayToken = (value: unknown): value is string =>
  isBase62Token(value, INVOICE_PAY_TOKEN_LENGTH)

export const mintInvoicePayToken = (
  random?: (bytes: number) => Uint8Array,
): string => mintBase62Token(16, INVOICE_PAY_TOKEN_LENGTH, random)

export const invoicePayUrl = (appUrl: string, token: string): string =>
  new URL(`/pay/${token}`, appUrl).toString()

/**
 * What a draft needs before it can open as a checkout invoice: the webhook
 * endpoint must carry the checkout events (a workspace connected before them
 * is upgraded in place), the contact must be a Stripe customer, and the pay
 * link must exist. No session is created here: the first visit mints it.
 */
export async function prepareCheckoutInvoice(props: {
  credentials: StripeCredentials
  invoice: InvoiceModel
}): Promise<{
  providerCustomerId: string
  payToken: string
  hostedUrl: string
}> {
  const { credentials, invoice } = props
  const totalMinor = decimalStringToMinor(invoice.total, invoice.currency)
  if (totalMinor <= 0n || totalMinor > STRIPE_MAX_AMOUNT_MINOR) {
    throw new InvoiceProviderError(
      "Invoice total is outside what Stripe accepts",
      false,
    )
  }
  try {
    await integrationStripeService.ensureWebhookEvents(credentials)
  } catch (error) {
    throw new InvoiceProviderError(
      error instanceof Error ? error.message : "webhook endpoint update failed",
      true,
    )
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  const providerCustomerId = await ensureCustomer(stripe, credentials, invoice)
  const payToken = mintInvoicePayToken()
  const appUrl = await resolveWorkspaceAppUrl({
    workspaceId: invoice.workspaceId,
  })
  return {
    providerCustomerId,
    payToken,
    hostedUrl: invoicePayUrl(appUrl, payToken),
  }
}

type SessionState =
  | { state: "live"; url: string }
  | { state: "complete" }
  | { state: "gone" }

/**
 * Read a recorded session; one that is open but about to lapse is expired
 * here. `complete` = the person paid (or an async payment is pending): never
 * mint another session then, the webhook settles the invoice.
 */
async function settleRecordedSession(
  stripe: Stripe,
  sessionId: string,
): Promise<SessionState> {
  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId)
  } catch (error) {
    throw wrapStripeError(error, "retrieve checkout session")
  }
  if (session.status === "complete") {
    return { state: "complete" }
  }
  if (session.status !== "open") {
    return { state: "gone" }
  }
  if (
    session.url &&
    session.expires_at * 1000 - Date.now() >= CHECKOUT_REUSE_MIN_MS
  ) {
    return { state: "live", url: session.url }
  }
  return await expireSession(stripe, sessionId)
}

/** Expire an open session; a session that completed meanwhile says so. */
async function expireSession(
  stripe: Stripe,
  sessionId: string,
): Promise<Exclude<SessionState, { state: "live" }>> {
  try {
    const expired = await stripe.checkout.sessions.expire(sessionId)
    return expired.status === "complete"
      ? { state: "complete" }
      : { state: "gone" }
  } catch (error) {
    // Only an open session can be expired: re-read to learn which it became.
    let session: Stripe.Checkout.Session
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId)
    } catch {
      throw wrapStripeError(error, "expire checkout session")
    }
    if (session.status === "complete") {
      return { state: "complete" }
    }
    if (session.status === "expired") {
      return { state: "gone" }
    }
    throw wrapStripeError(error, "expire checkout session")
  }
}

function sessionParams(
  invoice: InvoiceModel,
  lines: InvoiceLineItemModel[],
  mintedAt: Date,
): Stripe.Checkout.SessionCreateParams {
  const metadata = {
    hub_invoice_id: invoice.id,
    hub_workspace_id: invoice.workspaceId,
    hub_invoice_number: String(invoice.number),
  }
  return {
    mode: "payment",
    ...(invoice.providerCustomerId
      ? { customer: invoice.providerCustomerId }
      : {}),
    line_items: lines.map((line) => ({
      quantity: line.quantity,
      price_data: {
        currency: invoice.currency.toLowerCase(),
        unit_amount: Number(
          decimalStringToMinor(line.unitAmount, invoice.currency),
        ),
        product_data: { name: line.description },
      },
    })),
    expires_at: Math.floor(
      (mintedAt.getTime() + CHECKOUT_SESSION_TTL_MS) / 1000,
    ),
    // Back to the hub link: it shows "paid" or "processing", never a new session.
    success_url: `${invoice.hostedUrl ?? ""}?done=1`,
    client_reference_id: invoice.id,
    metadata,
    // No setup_future_usage: a one-time payment, the card is not saved.
    payment_intent_data: {
      description: `Invoice #${invoice.number}`,
      metadata,
    },
  }
}

/**
 * Create (or, for a racer of the same generation, re-fetch through the same
 * Idempotency-Key) the session of the row's claimed generation, check its
 * total, and record it while that generation is still current.
 */
async function mintSession(props: {
  stripe: Stripe
  invoice: InvoiceModel
  lines: InvoiceLineItemModel[]
  mintedAt: Date
}): Promise<{ recorded: boolean; session: Stripe.Checkout.Session }> {
  const { stripe, invoice, lines, mintedAt } = props
  const totalMinor = decimalStringToMinor(invoice.total, invoice.currency)
  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.create(
      sessionParams(invoice, lines, mintedAt),
      {
        idempotencyKey: `hub-inv-${invoice.id}-cs-${invoice.checkoutGeneration}`,
      },
    )
  } catch (error) {
    throw wrapStripeError(error, "create checkout session")
  }
  if (
    session.amount_total === null ||
    BigInt(session.amount_total) !== totalMinor ||
    session.currency?.toLowerCase() !== invoice.currency.toLowerCase()
  ) {
    await expireSession(stripe, session.id).catch((error: unknown) =>
      logger.error(
        { err: error, invoiceId: invoice.id, sessionId: session.id },
        "invoice: checkout total mismatch and the session could not be expired",
      ),
    )
    throw new InvoiceProviderError(
      `Stripe checkout total ${session.amount_total} ${session.currency} does not match the hub total ${totalMinor} ${invoice.currency}`,
      false,
    )
  }
  const [stored] = await db
    .update(invoiceModel)
    .set({ checkoutSessionId: session.id, updatedAt: new Date() })
    .where(
      and(
        eq(invoiceModel.id, invoice.id),
        eq(invoiceModel.status, "open"),
        eq(invoiceModel.checkoutGeneration, invoice.checkoutGeneration),
        isNull(invoiceModel.checkoutSessionId),
      ),
    )
    .returning({ id: invoiceModel.id })
  return { recorded: !!stored, session }
}

/** Claim the next generation from exactly the state this visit read. */
async function claimGeneration(
  invoice: InvoiceModel,
): Promise<InvoiceModel | null> {
  const [claimed] = await db
    .update(invoiceModel)
    .set({
      checkoutGeneration: invoice.checkoutGeneration + 1,
      checkoutMintedAt: new Date(),
      checkoutSessionId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invoiceModel.id, invoice.id),
        eq(invoiceModel.status, "open"),
        eq(invoiceModel.checkoutGeneration, invoice.checkoutGeneration),
        invoice.checkoutSessionId
          ? eq(invoiceModel.checkoutSessionId, invoice.checkoutSessionId)
          : isNull(invoiceModel.checkoutSessionId),
      ),
    )
    .returning()
  return claimed ?? null
}

export type CheckoutVisit =
  | { kind: "redirect"; url: string; invoice: InvoiceModel }
  /** Paid here, or a payment completed at Stripe that the webhook has not settled yet. */
  | { kind: "paid" | "processing"; invoice: InvoiceModel }
  | { kind: "closed"; invoice: InvoiceModel }
  /** Stripe is disconnected, replaced, or unreachable: try again later. */
  | { kind: "unavailable"; invoice: InvoiceModel }
  | { kind: "notFound" }

const loadByToken = async (token: string) =>
  await db.query.invoiceModel.findFirst({
    where: { payToken: token },
    with: { lineItems: { orderBy: { position: "asc" } } },
  })

/**
 * One visit to `/pay/<token>`: send the person to the invoice's live
 * session, minting the next one when there is none. A link-preview fetch
 * only mints an unpaid session; it never changes what the invoice owes.
 */
export async function visitCheckout(token: string): Promise<CheckoutVisit> {
  if (!isInvoicePayToken(token)) {
    return { kind: "notFound" }
  }
  let row = await loadByToken(token)
  if (row?.method !== "stripeCheckout") {
    return { kind: "notFound" }
  }
  const lines = row.lineItems
  const credentials = await integrationStripeService.credentialsByWorkspaceId(
    row.workspaceId,
  )
  for (let round = 0; round < MAX_VISIT_ROUNDS && row; round += 1) {
    if (row.status === "paid" || row.status === "refunded") {
      return { kind: "paid", invoice: row }
    }
    if (row.status !== "open") {
      return { kind: "closed", invoice: row }
    }
    if (
      !credentials ||
      row.integrationId !== credentials.integrationId ||
      row.providerAccountId !== credentials.accountId
    ) {
      return { kind: "unavailable", invoice: row }
    }
    const stripe = createStripeClient(credentials.auth.secretKey)
    if (row.checkoutSessionId) {
      const recorded = await settleRecordedSession(
        stripe,
        row.checkoutSessionId,
      )
      if (recorded.state === "live") {
        return { kind: "redirect", url: recorded.url, invoice: row }
      }
      if (recorded.state === "complete") {
        return { kind: "processing", invoice: row }
      }
      // Expired: nothing of this generation is payable any more.
      await claimGeneration(row)
    } else if (
      !row.checkoutMintedAt ||
      Date.now() - row.checkoutMintedAt.getTime() > PENDING_MINT_JOIN_MS
    ) {
      await claimGeneration(row)
    } else {
      const minted = await mintSession({
        stripe,
        invoice: row,
        lines,
        mintedAt: row.checkoutMintedAt,
      })
      if (minted.recorded && minted.session.url) {
        return { kind: "redirect", url: minted.session.url, invoice: row }
      }
      const current = await loadByToken(token)
      if (current?.checkoutSessionId === minted.session.id) {
        // A racer of the same generation recorded this very session.
        row = current
        continue
      }
      // The generation moved on or the invoice was voided while this visit
      // minted: the session it created must not stay payable.
      const orphan = await expireSession(stripe, minted.session.id)
      if (orphan.state === "complete") {
        logger.error(
          { invoiceId: row.id, sessionId: minted.session.id },
          "invoice: an unrecorded checkout session was paid; the webhook flags it",
        )
      }
      row = current
      continue
    }
    // Claimed a generation or lost the claim: re-read either way.
    row = await loadByToken(token)
  }
  if (!row) {
    return { kind: "notFound" }
  }
  logger.warn(
    { invoiceId: row.id },
    "invoice: checkout visit gave up after repeated races",
  )
  return { kind: "unavailable", invoice: row }
}

/**
 * Before a checkout invoice is voided: a recorded session that already
 * completed means the person paid (the webhook is on its way), so the void
 * is refused rather than leave a payment under a void row.
 */
export async function assertCheckoutNotPaid(props: {
  credentials: StripeCredentials
  invoice: InvoiceModel
}): Promise<void> {
  const { credentials, invoice } = props
  if (!invoice.checkoutSessionId) {
    return
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  let session: Stripe.Checkout.Session
  try {
    session = await stripe.checkout.sessions.retrieve(invoice.checkoutSessionId)
  } catch (error) {
    throw wrapStripeError(error, "retrieve checkout session")
  }
  if (session.status === "complete") {
    throw new InvoiceProviderError(
      "This invoice was just paid at Stripe; it cannot be voided",
      false,
    )
  }
}

/**
 * After a checkout invoice was voided here: expire the session the void row
 * names. A visit minting at that moment cannot record its session on a void
 * row and expires it itself (`visitCheckout`).
 */
export async function expireCheckoutAfterVoid(props: {
  credentials: StripeCredentials
  invoice: InvoiceModel
}): Promise<void> {
  const { credentials, invoice } = props
  if (!invoice.checkoutSessionId) {
    return
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  const result = await expireSession(stripe, invoice.checkoutSessionId)
  if (result.state === "complete") {
    logger.error(
      { invoiceId: invoice.id, sessionId: invoice.checkoutSessionId },
      "invoice: voided while its checkout session completed; the webhook flags the payment",
    )
  }
}
