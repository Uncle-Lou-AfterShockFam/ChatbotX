import { and, db, eq } from "@chatbotx.io/database/client"
import type { InvoiceStatus } from "@chatbotx.io/database/partials"
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

const INTEGRATION_ID = /^\d{1,20}$/

/** Event type -> the hub status it asks for (null = no status change). */
const TARGET_STATUS: Record<string, InvoiceStatus | null> = {
  "invoice.paid": "paid",
  "invoice.voided": "void",
  "invoice.marked_uncollectible": "uncollectible",
  "invoice.payment_failed": null,
  "charge.refunded": "refunded",
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
    const charge = event.data.object as Stripe.Charge
    // Only a FULL refund moves the invoice; a partial one is recorded only.
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
    const invoice = payments.data[0]?.invoice
    return typeof invoice === "string" ? invoice : (invoice?.id ?? null)
  }
  return null
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

  let hubInvoice: InvoiceModel | null = null
  let stripeInvoice: Stripe.Invoice | null = null
  try {
    const stripeInvoiceId = await stripeInvoiceIdOf(stripe, event)
    if (stripeInvoiceId) {
      stripeInvoice = await stripe.invoices.retrieve(stripeInvoiceId)
      hubInvoice = await findHubInvoice(credentials, stripeInvoice)
    }
  } catch (error) {
    if (isRetryableStripeError(error)) {
      return { outcome: "retry", detail: "stripe unreachable" }
    }
    logger.warn(
      { err: error, eventId: event.id },
      "stripe webhook: invoice lookup failed",
    )
  }

  const target = TARGET_STATUS[event.type] ?? null
  const confirmed =
    target === null ||
    (stripeInvoice !== null &&
      stripeInvoice.status === CONFIRMING_STRIPE_STATUS[target])

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
        paid: { paidAt: now },
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

  const current: InvoiceModel = applied ?? hubInvoice
  try {
    if (target && (applied || hubInvoice.status === target)) {
      // A fresh event whose target the invoice already holds re-runs the
      // marks: the only way here without `applied` is a redelivery after a
      // failed mark attempt (its event row was removed below), since a
      // dashboard resend reuses the event id and is a duplicate.
      await markInvoiceOnContact({ invoice: current, status: target })
      if (target === "paid") {
        await emitInvoicePaid(
          current.workspaceId,
          current.contactId,
          invoiceEventMetadata(current),
        )
      }
    } else if (
      event.type === "invoice.payment_failed" &&
      current.status === "open" &&
      stripeInvoice?.status === "open"
    ) {
      await markInvoiceOnContact({ invoice: current, status: "payment_failed" })
      await emitInvoicePaymentFailed(
        current.workspaceId,
        current.contactId,
        invoiceEventMetadata(current),
      )
    }
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
