import { createHmac, timingSafeEqual } from "node:crypto"
import { and, db, eq, isNull, or } from "@chatbotx.io/database/client"
import type { InvoiceStatus } from "@chatbotx.io/database/partials"
import { invoiceEventModel, invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { emitInvoicePaid } from "@chatbotx.io/events"
import { isPgBigintId } from "../integration-woocommerce/client"
import { integrationWooCommerceService } from "../integration-woocommerce/service"
import { logger } from "../logger"
import { markInvoiceOnContact } from "./contact-marks"
import { prerenderInvoiceReceipt } from "./document"
import { enqueueInvoiceMirror } from "./mirror"
import { invoiceEventMetadata, invoiceService } from "./service"
import { wooCommerceProviderInvoiceId } from "./woocommerce-provider"

/** hub-connector signs with a fresh timestamp per attempt (Standard Webhooks). */
export const WOOCOMMERCE_WEBHOOK_TOLERANCE_SECONDS = 300

/**
 * The answer, in hub-connector's `reason` vocabulary (Worker::classify):
 * `applied` / `duplicate` / `captured` end the outbox row; `hub-error` and
 * `no-token` make the site retry the SAME event id with backoff (12 attempts
 * over ~4 days); `invalid:*` dead-letters it. An unknown site or a bad
 * signature is `no-token`, never a dead letter: a reconnect not yet in the
 * site's wp-config, or a skewed clock, must not lose a payment (s211b review).
 */
export type WooCommerceWebhookReason =
  | "applied"
  | "duplicate"
  | "captured"
  | "hub-error"
  | "no-token"
  | "invalid:envelope"

export type WooCommerceWebhookResult = {
  reason: WooCommerceWebhookReason
  detail: string
}

/**
 * Envelope event -> invoice status. `order.completed` is a payment too: a
 * manual-payment order (BACS, cheque) never fires `order.paid`. A Map, not an
 * object literal: `constructor` / `__proto__` must not resolve (s211b probe).
 */
const TARGET = new Map<string, InvoiceStatus>([
  ["order.paid", "paid"],
  ["order.completed", "paid"],
  ["order.refunded", "refunded"],
])

/** Statuses a refund may arrive in before its payment did (retry, not settle). */
const PAYMENT_PENDING: readonly InvoiceStatus[] = [
  "draft",
  "open",
  "uncollectible",
]

/** The event outcome that says this invoice's contact marks for a status ran. */
const markedOutcome = (status: InvoiceStatus) => `marked:${status}`
const EVENT_ID = /^[A-Za-z0-9_-]{1,120}$/
const TIMESTAMP = /^\d{1,12}$/

/**
 * Standard Webhooks: `v1,<base64 HMAC-SHA256(key, "{id}.{ts}.{body}")>`,
 * several space-separated signatures allowed, key = the base64 after `whsec_`.
 */
export function verifyStandardWebhook(props: {
  secret: string
  id: string | null
  timestamp: string | null
  signature: string | null
  rawBody: Buffer
  nowSeconds: number
}): boolean {
  const { id, timestamp, signature } = props
  if (
    !(
      id &&
      timestamp &&
      signature &&
      TIMESTAMP.test(timestamp) &&
      props.secret.startsWith("whsec_") &&
      props.secret.length > "whsec_".length
    )
  ) {
    return false
  }
  if (
    Math.abs(props.nowSeconds - Number(timestamp)) >
    WOOCOMMERCE_WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false
  }
  const key = Buffer.from(props.secret.slice("whsec_".length), "base64")
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(props.rawBody)
    .digest()
  return signature.split(" ").some((part) => {
    const [version, value] = part.split(",", 2)
    if (version !== "v1" || !value) {
      return false
    }
    const given = Buffer.from(value, "base64")
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

type OrderEnvelope = {
  id: string
  event: string
  orderId: string
  hubInvoiceId: string
}

/** The fields the hub reads from a hub-connector/1 order envelope, or null. */
export function parseOrderEnvelope(rawBody: Buffer): OrderEnvelope | null {
  let data: unknown
  try {
    data = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return null
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null
  }
  const envelope = data as Record<string, unknown>
  const subject = envelope.subject as Record<string, unknown> | undefined
  const fields = envelope.fields as Record<string, unknown> | undefined
  if (
    envelope.spec !== "hub-connector/1" ||
    typeof envelope.id !== "string" ||
    !EVENT_ID.test(envelope.id) ||
    typeof envelope.event !== "string"
  ) {
    return null
  }
  return {
    id: envelope.id,
    event: envelope.event,
    orderId:
      subject?.type === "order" && typeof subject.id === "string"
        ? subject.id
        : "",
    hubInvoiceId:
      typeof fields?.hub_invoice_id === "string" ? fields.hub_invoice_id : "",
  }
}

/**
 * The invoice this site's order collects, LOCKED for the transaction: named by
 * the envelope, bound to this site (integration AND origin), and either
 * already bound to this order or bound to none yet (a finalize whose answer
 * was lost, or a draft voided while the site was opening it). Any status: the
 * caller decides from the fresh, locked one.
 */
async function lockInvoice(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  props: {
    workspaceId: string
    integrationId: string
    siteUrl: string
    hubInvoiceId: string
    orderRef: string
  },
): Promise<InvoiceModel | null> {
  const [row] = await tx
    .select()
    .from(invoiceModel)
    .where(
      and(
        eq(invoiceModel.id, props.hubInvoiceId),
        eq(invoiceModel.workspaceId, props.workspaceId),
        eq(invoiceModel.method, "woocommerce"),
        eq(invoiceModel.integrationId, props.integrationId),
        eq(invoiceModel.providerAccountId, props.siteUrl),
        or(
          eq(invoiceModel.providerInvoiceId, props.orderRef),
          isNull(invoiceModel.providerInvoiceId),
        ),
      ),
    )
    .limit(1)
    .for("update")
  return row ?? null
}

async function dropDedupRow(integrationId: string, eventId: string) {
  try {
    await db
      .delete(invoiceEventModel)
      .where(
        and(
          eq(invoiceEventModel.integrationId, integrationId),
          eq(invoiceEventModel.providerEventId, eventId),
        ),
      )
  } catch (error) {
    logger.error(
      { err: error, eventId },
      "woocommerce webhook: dedup row not removed; this event's redelivery will be skipped",
    )
  }
}

type Decision =
  | { kind: "unmatched" | "refund-before-payment" | "duplicate" | "settled" }
  | {
      kind: "mark"
      invoice: InvoiceModel
      eventRowId: string
      applied: boolean
    }

/**
 * A linked site's order payment / completion / refund (hub-connector >= 0.6.0,
 * HUBC_HUB_URL). Verified with THAT site's hub-generated secret before
 * anything is parsed. One transaction locks the invoice, inserts the
 * per-site InvoiceEvent (the dedup) and moves the status by CAS, deciding
 * from the locked row: a refund before its payment is retried (nothing
 * recorded), a payment of an invoice voided here is flagged and never
 * applied, and the contact marks run once per status (`marked:<status>`),
 * however many events report it.
 */
export async function handleWooCommerceWebhook(props: {
  integrationId: string
  rawBody: Buffer
  headers: {
    id: string | null
    timestamp: string | null
    signature: string | null
  }
  nowSeconds?: number
}): Promise<WooCommerceWebhookResult> {
  const credentials =
    await integrationWooCommerceService.credentialsByIntegrationId(
      props.integrationId,
    )
  // An unknown site and a bad signature answer the same: no id oracle.
  if (
    !(
      credentials &&
      verifyStandardWebhook({
        secret: credentials.auth.webhookSecret,
        ...props.headers,
        rawBody: props.rawBody,
        nowSeconds: props.nowSeconds ?? Math.floor(Date.now() / 1000),
      })
    )
  ) {
    return { reason: "no-token", detail: "unverified" }
  }
  const envelope = parseOrderEnvelope(props.rawBody)
  if (!envelope || envelope.id !== props.headers.id) {
    return {
      reason: "invalid:envelope",
      detail: "not a hub-connector/1 envelope",
    }
  }
  const target = TARGET.get(envelope.event)
  if (!target) {
    return { reason: "captured", detail: `ignored ${envelope.event}` }
  }
  if (
    !(isPgBigintId(envelope.orderId) && isPgBigintId(envelope.hubInvoiceId))
  ) {
    return { reason: "captured", detail: "not a hub invoice's order" }
  }
  const orderRef = wooCommerceProviderInvoiceId(
    credentials.siteUrl,
    envelope.orderId,
  )

  let decision: Decision = { kind: "unmatched" }
  try {
    await db.transaction(async (tx) => {
      const invoice = await lockInvoice(tx, {
        workspaceId: credentials.workspaceId,
        integrationId: credentials.integrationId,
        siteUrl: credentials.siteUrl,
        hubInvoiceId: envelope.hubInvoiceId,
        orderRef,
      })
      if (!invoice) {
        decision = { kind: "unmatched" }
        return
      }
      if (target === "refunded" && PAYMENT_PENDING.includes(invoice.status)) {
        // Its payment is still on the way (the site retries rows out of
        // order): record nothing, so this refund is retried after it.
        decision = { kind: "refund-before-payment" }
        return
      }
      const [row] = await tx
        .insert(invoiceEventModel)
        .values({
          workspaceId: credentials.workspaceId,
          integrationId: credentials.integrationId,
          invoiceId: invoice.id,
          providerEventId: envelope.id,
          type: envelope.event,
          outcome: "received",
        })
        .onConflictDoNothing()
        .returning({ id: invoiceEventModel.id })
      if (!row) {
        decision = { kind: "duplicate" }
        return
      }
      const applied = await invoiceService.transition({
        invoiceId: invoice.id,
        to: target,
        set:
          target === "paid"
            ? { paidAt: new Date(), providerInvoiceId: orderRef }
            : {},
        tx,
      })
      if (applied) {
        decision = {
          kind: "mark",
          invoice: applied,
          eventRowId: row.id,
          applied: true,
        }
        return
      }
      if (invoice.status === target) {
        const [marked] = await tx
          .select({ id: invoiceEventModel.id })
          .from(invoiceEventModel)
          .where(
            and(
              eq(invoiceEventModel.invoiceId, invoice.id),
              eq(invoiceEventModel.outcome, markedOutcome(target)),
            ),
          )
          .limit(1)
        // Marks that never completed (a redelivery after a failed mark)
        // run now; a second report of the same status never re-runs them.
        decision = marked
          ? { kind: "settled" }
          : { kind: "mark", invoice, eventRowId: row.id, applied: false }
        return
      }
      const paidAfterVoid = target === "paid" && invoice.status === "void"
      await tx
        .update(invoiceEventModel)
        .set({
          outcome: paidAfterVoid
            ? "paid-after-void"
            : `ignored:${invoice.status}`,
          updatedAt: new Date(),
        })
        .where(eq(invoiceEventModel.id, row.id))
      if (paidAfterVoid) {
        await tx
          .update(invoiceModel)
          .set({
            providerInvoiceId: invoice.providerInvoiceId ?? orderRef,
            lastError: `Paid on ${credentials.siteSlug} (order ${envelope.orderId}) after it was voided here: refund it in WooCommerce`,
            updatedAt: new Date(),
          })
          .where(eq(invoiceModel.id, invoice.id))
      }
      decision = { kind: "settled" }
    })
  } catch (error) {
    logger.error(
      { err: error, eventId: envelope.id },
      "woocommerce webhook: write failed",
    )
    return { reason: "hub-error", detail: "database" }
  }

  // TS narrows `decision` to its initial value across the callback.
  const outcome = decision as Decision
  switch (outcome.kind) {
    case "unmatched":
      // A valid hub invoice id this site cannot match yet (a reconnect not
      // yet re-adopted, a site URL being moved): retried, never settled.
      logger.warn(
        {
          integrationId: credentials.integrationId,
          eventId: envelope.id,
          hubInvoiceId: envelope.hubInvoiceId,
        },
        "woocommerce webhook: no invoice of this site collects this order",
      )
      return { reason: "hub-error", detail: "no matching invoice" }
    case "refund-before-payment":
      return { reason: "hub-error", detail: "refund before its payment" }
    case "duplicate":
      return { reason: "duplicate", detail: envelope.id }
    case "settled":
      return { reason: "captured", detail: `${envelope.event} settled` }
    default:
      break
  }
  const { invoice } = outcome
  try {
    await markInvoiceOnContact({ invoice, status: target })
    if (target === "paid") {
      await emitInvoicePaid(
        invoice.workspaceId,
        invoice.contactId,
        invoiceEventMetadata(invoice),
      )
    }
  } catch (error) {
    await dropDedupRow(credentials.integrationId, envelope.id)
    logger.warn(
      { err: error, eventId: envelope.id, invoiceId: invoice.id },
      "woocommerce webhook: contact marks failed, asking the site to redeliver",
    )
    return { reason: "hub-error", detail: "contact marks" }
  }
  try {
    await db
      .update(invoiceEventModel)
      .set({ outcome: markedOutcome(target), updatedAt: new Date() })
      .where(eq(invoiceEventModel.id, outcome.eventRowId))
  } catch (error) {
    // The marks ran; a later report of this status may re-run them once.
    logger.warn(
      { err: error, eventId: envelope.id },
      "woocommerce webhook: marked outcome not recorded",
    )
  }
  if (target === "paid") {
    // Not awaited: Gotenberg must not hold the site's delivery open. It
    // never rejects (it logs its own failure); the catch is belt and braces.
    prerenderInvoiceReceipt(invoice.id).catch(() => undefined)
  }
  if (outcome.applied) {
    await enqueueInvoiceMirror(invoice)
  }
  return {
    reason: outcome.applied ? "applied" : "captured",
    detail: `${envelope.event} invoice ${invoice.id}`,
  }
}
