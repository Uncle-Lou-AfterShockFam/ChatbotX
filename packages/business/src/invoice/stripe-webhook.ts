import { and, db, eq } from "@chatbotx.io/database/client"
import {
  decimalStringToMinor,
  type InvoiceStatus,
} from "@chatbotx.io/database/partials"
import { invoiceEventModel, invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { emitInvoicePaid, emitInvoicePaymentFailed } from "@chatbotx.io/events"
import {
  createStripeClient,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  type Stripe,
} from "../integration-stripe/client"
import {
  integrationStripeService,
  type StripeCredentials,
} from "../integration-stripe/service"
import { logger } from "../logger"
import { markInvoiceOnContact } from "./contact-marks"
import { invoiceEventMetadata, invoiceService } from "./service"
import { isRetryableStripeError } from "./stripe-provider"

/**
 * `ignored`/`duplicate`/`applied`/`noop` answer 200 (Stripe stops);
 * `retry` answers 503 so Stripe redelivers; `rejected` answers 400 (bad
 * signature, mode mismatch) and `unknown` 404 (no such integration).
 */
export type StripeWebhookOutcome =
  | "applied"
  | "noop"
  | "duplicate"
  | "ignored"
  | "retry"
  | "rejected"
  | "unknown"

export type StripeWebhookResult = {
  outcome: StripeWebhookOutcome
  detail: string
}

/** A hub bigint id (integration or invoice). */
const INTEGRATION_ID = /^\d{1,20}$/

/** Event type -> the hub status it asks for (null = no status change). */
const TARGET_STATUS: Record<string, InvoiceStatus | null> = {
  "invoice.paid": "paid",
  "invoice.voided": "void",
  "invoice.marked_uncollectible": "uncollectible",
  "invoice.payment_failed": null,
  "charge.refunded": "refunded",
  // stripeCheckout (s207b)
  "checkout.session.completed": "paid",
  "checkout.session.async_payment_succeeded": "paid",
  "checkout.session.async_payment_failed": null,
}

/** What an event resolved to, re-read from Stripe. */
type Resolution = {
  hubInvoice: InvoiceModel | null
  /** Stripe itself shows the state the event asks for. */
  confirmed: boolean
  /** A failed payment while the invoice is still payable. */
  failedWhileOpen: boolean
  /** stripeCheckout: the PaymentIntent that paid (becomes providerInvoiceId). */
  paymentIntentId: string | null
}

const UNRESOLVED: Resolution = {
  hubInvoice: null,
  confirmed: false,
  failedWhileOpen: false,
  paymentIntentId: null,
}

const idOf = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : (value?.id ?? null)

/** A stripeCheckout hub invoice named by Stripe metadata, in this integration. */
async function findCheckoutInvoice(
  credentials: StripeCredentials,
  metadata: Stripe.Metadata | null | undefined,
): Promise<InvoiceModel | null> {
  const hubInvoiceId = metadata?.hub_invoice_id
  if (
    !(hubInvoiceId && INTEGRATION_ID.test(hubInvoiceId)) ||
    metadata?.hub_workspace_id !== credentials.workspaceId
  ) {
    return null
  }
  const [row] = await db
    .select()
    .from(invoiceModel)
    .where(
      and(
        eq(invoiceModel.id, hubInvoiceId),
        eq(invoiceModel.workspaceId, credentials.workspaceId),
        eq(invoiceModel.integrationId, credentials.integrationId),
        eq(invoiceModel.method, "stripeCheckout"),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * A `checkout.session.*` event: the session is re-read and must be paid for
 * exactly the hub total. Any session of the invoice counts (an older one can
 * only have completed before it was expired).
 */
async function resolveCheckoutSession(
  stripe: Stripe,
  credentials: StripeCredentials,
  event: Stripe.Event,
): Promise<Resolution> {
  const signed = event.data.object as { id?: unknown }
  if (typeof signed.id !== "string") {
    return UNRESOLVED
  }
  const session = await stripe.checkout.sessions.retrieve(signed.id)
  const hubInvoice = await findCheckoutInvoice(credentials, session.metadata)
  if (!hubInvoice) {
    return UNRESOLVED
  }
  const paymentIntentId = idOf(session.payment_intent)
  if (event.type === "checkout.session.async_payment_failed") {
    return {
      hubInvoice,
      confirmed: true,
      failedWhileOpen: session.payment_status === "unpaid",
      paymentIntentId,
    }
  }
  const paidInFull =
    session.payment_status === "paid" &&
    session.amount_total !== null &&
    BigInt(session.amount_total) ===
      decimalStringToMinor(hubInvoice.total, hubInvoice.currency) &&
    session.currency?.toLowerCase() === hubInvoice.currency.toLowerCase()
  if (session.payment_status === "paid" && !paidInFull) {
    logger.error(
      { eventId: event.id, invoiceId: hubInvoice.id, sessionId: session.id },
      "stripe webhook: checkout session paid an amount that is not the hub total",
    )
  }
  return {
    hubInvoice,
    confirmed: paidInFull && !!paymentIntentId,
    failedWhileOpen: false,
    paymentIntentId,
  }
}

async function stripeInvoiceIdOf(
  stripe: Stripe,
  event: Stripe.Event,
): Promise<string | null> {
  if (event.type.startsWith("invoice.")) {
    const object = event.data.object as { id?: unknown }
    return typeof object.id === "string" ? object.id : null
  }
  if (event.type === "charge.refunded") {
    const signed = event.data.object as { id?: unknown }
    if (typeof signed.id !== "string") {
      return null
    }
    // Re-read the charge: the event body alone never marks an invoice
    // refunded. Only a FULL refund moves it; a partial one is recorded only.
    const charge = await stripe.charges.retrieve(signed.id)
    if (!charge.refunded) {
      return null
    }
    const paymentIntent =
      typeof charge.payment_intent === "string"
        ? charge.payment_intent
        : charge.payment_intent?.id
    if (!paymentIntent) {
      return null
    }
    const payments = await stripe.invoicePayments.list({
      payment: { type: "payment_intent", payment_intent: paymentIntent },
      limit: 1,
    })
    return idOf(payments.data[0]?.invoice)
  }
  return null
}

/**
 * A full refund of a stripeCheckout payment: no Stripe invoice exists, the
 * PaymentIntent carries the hub metadata and IS the row's providerInvoiceId.
 */
async function resolveCheckoutRefund(
  stripe: Stripe,
  credentials: StripeCredentials,
  event: Stripe.Event,
): Promise<Resolution> {
  const signed = event.data.object as { id?: unknown }
  if (typeof signed.id !== "string") {
    return UNRESOLVED
  }
  const charge = await stripe.charges.retrieve(signed.id)
  const paymentIntentId = idOf(charge.payment_intent)
  if (!(charge.refunded && paymentIntentId)) {
    return UNRESOLVED
  }
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId)
  const hubInvoice = await findCheckoutInvoice(
    credentials,
    paymentIntent.metadata,
  )
  if (!hubInvoice || hubInvoice.providerInvoiceId !== paymentIntentId) {
    return UNRESOLVED
  }
  return {
    hubInvoice,
    confirmed: true,
    failedWhileOpen: false,
    paymentIntentId,
  }
}

/** Resolve an invoice.* or charge.refunded event through the Stripe invoice. */
async function resolveStripeInvoice(
  stripe: Stripe,
  credentials: StripeCredentials,
  event: Stripe.Event,
  target: InvoiceStatus | null,
): Promise<Resolution | null> {
  const stripeInvoiceId = await stripeInvoiceIdOf(stripe, event)
  if (!stripeInvoiceId) {
    return null
  }
  const stripeInvoice = await stripe.invoices.retrieve(stripeInvoiceId)
  const hubInvoice = await findHubInvoice(credentials, stripeInvoice)
  return {
    hubInvoice,
    confirmed:
      target === null ||
      stripeInvoice.status === CONFIRMING_STRIPE_STATUS[target],
    failedWhileOpen:
      event.type === "invoice.payment_failed" &&
      stripeInvoice.status === "open",
    paymentIntentId: null,
  }
}

async function resolveEvent(
  stripe: Stripe,
  credentials: StripeCredentials,
  event: Stripe.Event,
  target: InvoiceStatus | null,
): Promise<Resolution> {
  if (event.type.startsWith("checkout.session.")) {
    return await resolveCheckoutSession(stripe, credentials, event)
  }
  const viaInvoice = await resolveStripeInvoice(
    stripe,
    credentials,
    event,
    target,
  )
  if (viaInvoice) {
    return viaInvoice
  }
  if (event.type === "charge.refunded") {
    return await resolveCheckoutRefund(stripe, credentials, event)
  }
  return UNRESOLVED
}

/**
 * The Stripe status the event must be backed by, re-read from Stripe: a
 * forged or stale event (a leaked secret, a replay inside the tolerance) can
 * never move an invoice the provider itself does not show in that state.
 */
const CONFIRMING_STRIPE_STATUS: Partial<
  Record<InvoiceStatus, Stripe.Invoice.Status>
> = {
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
  refunded: "paid",
}

async function findHubInvoice(
  credentials: StripeCredentials,
  stripeInvoice: Stripe.Invoice,
): Promise<InvoiceModel | null> {
  if (!stripeInvoice.id) {
    return null
  }
  const [row] = await db
    .select()
    .from(invoiceModel)
    .where(
      and(
        eq(invoiceModel.providerInvoiceId, stripeInvoice.id),
        eq(invoiceModel.workspaceId, credentials.workspaceId),
        eq(invoiceModel.integrationId, credentials.integrationId),
      ),
    )
    .limit(1)
  if (!row) {
    return null
  }
  // Belt and braces: the Stripe invoice must name this hub row.
  if (stripeInvoice.metadata?.hub_invoice_id !== row.id) {
    return null
  }
  return row
}

/**
 * What a confirmed, freshly recorded event writes onto the contact and emits.
 * A fresh event whose target the invoice already holds re-runs the marks: the
 * only way there without `applied` is a redelivery after a failed mark
 * attempt (its event row was removed), since a dashboard resend reuses the
 * event id and is a duplicate.
 */
async function markAndEmit(props: {
  target: InvoiceStatus | null
  applied: InvoiceModel | null
  hubInvoice: InvoiceModel
  failedWhileOpen: boolean
}): Promise<void> {
  const { target, applied, hubInvoice } = props
  const current = applied ?? hubInvoice
  if (target && (applied || hubInvoice.status === target)) {
    await markInvoiceOnContact({ invoice: current, status: target })
    if (target === "paid") {
      await emitInvoicePaid(
        current.workspaceId,
        current.contactId,
        invoiceEventMetadata(current),
      )
    }
    return
  }
  if (target === null && current.status === "open" && props.failedWhileOpen) {
    await markInvoiceOnContact({ invoice: current, status: "payment_failed" })
    await emitInvoicePaymentFailed(
      current.workspaceId,
      current.contactId,
      invoiceEventMetadata(current),
    )
  }
}

/**
 * A confirmed checkout payment the invoice did not take: either a redelivery
 * of the payment it already recorded (returns the row, marks re-run), or a
 * SECOND payment (another session, or one after a void). The second is never
 * applied or marked: it is recorded on the event, put in `lastError` for the
 * operator, and logged; refunding it is a human decision.
 */
async function settleUnappliedCheckoutPayment(props: {
  credentials: StripeCredentials
  event: Stripe.Event
  hubInvoice: InvoiceModel
  paymentIntentId: string
}): Promise<InvoiceModel | null> {
  const { credentials, event, hubInvoice, paymentIntentId } = props
  const [current] = await db
    .select()
    .from(invoiceModel)
    .where(eq(invoiceModel.id, hubInvoice.id))
    .limit(1)
  if (current?.providerInvoiceId === paymentIntentId) {
    return current
  }
  logger.error(
    {
      eventId: event.id,
      invoiceId: hubInvoice.id,
      paymentIntentId,
      status: current?.status,
    },
    "stripe webhook: a second payment reached a checkout invoice; refund it in Stripe",
  )
  await db.transaction(async (tx) => {
    await tx
      .update(invoiceEventModel)
      .set({ outcome: "duplicate-payment", updatedAt: new Date() })
      .where(
        and(
          eq(invoiceEventModel.integrationId, credentials.integrationId),
          eq(invoiceEventModel.providerEventId, event.id),
        ),
      )
    await tx
      .update(invoiceModel)
      .set({
        lastError: `A second payment (${paymentIntentId}) reached this ${current?.status ?? "unknown"} invoice: refund it in Stripe`,
        updatedAt: new Date(),
      })
      .where(eq(invoiceModel.id, hubInvoice.id))
  })
  return null
}

/**
 * Verify, dedup and apply one Stripe webhook delivery for one workspace
 * integration. `rawBody` MUST be the exact bytes Stripe sent.
 */
export async function handleStripeWebhook(props: {
  integrationId: string
  rawBody: Buffer
  signature: string | null
}): Promise<StripeWebhookResult> {
  if (!INTEGRATION_ID.test(props.integrationId)) {
    return { outcome: "unknown", detail: "integration id" }
  }
  let credentials: StripeCredentials | null
  try {
    credentials = await integrationStripeService.credentialsByIntegrationId(
      props.integrationId,
    )
  } catch (error) {
    logger.error({ err: error }, "stripe webhook: credentials unreadable")
    return { outcome: "retry", detail: "credentials" }
  }
  if (!credentials) {
    return { outcome: "unknown", detail: "no such integration" }
  }
  if (!props.signature) {
    return { outcome: "rejected", detail: "missing signature" }
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      props.rawBody,
      props.signature,
      credentials.auth.webhookSecret,
      STRIPE_WEBHOOK_TOLERANCE_SECONDS,
    )
  } catch {
    return { outcome: "rejected", detail: "bad signature" }
  }
  if (event.livemode !== credentials.livemode) {
    return { outcome: "rejected", detail: "livemode mismatch" }
  }
  if (!Object.hasOwn(TARGET_STATUS, event.type)) {
    return { outcome: "ignored", detail: event.type }
  }

  const target = TARGET_STATUS[event.type] ?? null
  let resolution = UNRESOLVED
  try {
    resolution = await resolveEvent(stripe, credentials, event, target)
  } catch (error) {
    if (isRetryableStripeError(error)) {
      return { outcome: "retry", detail: "stripe unreachable" }
    }
    logger.warn(
      { err: error, eventId: event.id },
      "stripe webhook: invoice lookup failed",
    )
  }
  let { hubInvoice } = resolution
  const { confirmed, paymentIntentId } = resolution

  let applied = null as InvoiceModel | null
  let inserted = false as boolean
  let outcomeLabel = "unknown-invoice"
  if (hubInvoice) {
    outcomeLabel = confirmed ? "received" : "unconfirmed"
  }
  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoiceEventModel)
        .values({
          workspaceId: credentials.workspaceId,
          integrationId: credentials.integrationId,
          invoiceId: hubInvoice?.id ?? null,
          providerEventId: event.id,
          type: event.type,
          outcome: outcomeLabel,
        })
        .onConflictDoNothing()
        .returning({ id: invoiceEventModel.id })
      inserted = !!row
      if (!(row && hubInvoice && confirmed && target)) {
        return
      }
      const now = new Date()
      const stamps = {
        // A checkout payment's PaymentIntent is its provider id (refunds resolve by it).
        paid: {
          paidAt: now,
          ...(paymentIntentId ? { providerInvoiceId: paymentIntentId } : {}),
        },
        void: { voidedAt: now },
      } as const
      applied = await invoiceService.transition({
        invoiceId: hubInvoice.id,
        to: target,
        set: target === "paid" || target === "void" ? stamps[target] : {},
        tx,
      })
    })
  } catch (error) {
    logger.error(
      { err: error, eventId: event.id },
      "stripe webhook: write failed",
    )
    return { outcome: "retry", detail: "database" }
  }
  if (!inserted) {
    return { outcome: "duplicate", detail: event.id }
  }
  if (!(hubInvoice && confirmed)) {
    return { outcome: "noop", detail: outcomeLabel }
  }

  if (target === "paid" && paymentIntentId && !applied) {
    const settled = await settleUnappliedCheckoutPayment({
      credentials,
      event,
      hubInvoice,
      paymentIntentId,
    })
    if (!settled) {
      return { outcome: "noop", detail: "duplicate-payment" }
    }
    hubInvoice = settled
  }

  try {
    await markAndEmit({
      target,
      applied,
      hubInvoice,
      failedWhileOpen: resolution.failedWhileOpen,
    })
  } catch (error) {
    // Let Stripe redeliver: drop the dedup row so the retry is not a duplicate.
    await db
      .delete(invoiceEventModel)
      .where(
        and(
          eq(invoiceEventModel.integrationId, credentials.integrationId),
          eq(invoiceEventModel.providerEventId, event.id),
        ),
      )
      .catch(() => undefined)
    logger.warn(
      { err: error, eventId: event.id, invoiceId: hubInvoice.id },
      "stripe webhook: contact marks failed, asking Stripe to redeliver",
    )
    return { outcome: "retry", detail: "contact marks" }
  }
  return {
    outcome: applied ? "applied" : "noop",
    detail: `${event.type} invoice ${hubInvoice.id}`,
  }
}
