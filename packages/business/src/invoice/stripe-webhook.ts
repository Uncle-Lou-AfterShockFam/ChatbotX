import { and, db, eq, inArray } from "@chatbotx.io/database/client"
import {
  decimalStringToMinor,
  type InvoiceCheckoutKind,
  type InvoiceStatus,
  invoiceCheckoutKinds,
} from "@chatbotx.io/database/partials"
import {
  invoiceEventModel,
  invoiceModel,
  invoicePaymentModel,
} from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import {
  emitInvoicePaid,
  emitInvoicePartiallyPaid,
  emitInvoicePaymentFailed,
} from "@chatbotx.io/events"
import {
  createStripeClient,
  STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  type Stripe,
  Stripe as StripeSdk,
} from "../integration-stripe/client"
import {
  integrationStripeService,
  type StripeCredentials,
} from "../integration-stripe/service"
import { logger } from "../logger"
import { markInvoiceOnContact } from "./contact-marks"
import { prerenderInvoiceReceipt } from "./document"
import { enqueueInvoiceMirror } from "./mirror"
import {
  type AppliedPayment,
  applyCheckoutPayment,
  claimPaymentMarks,
  releasePaymentMarks,
} from "./payments"
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
  /** stripeCheckout: the session the event is about. */
  sessionId?: string
  /** stripeCheckout (s216b): what the paid session collected. */
  payment?: { kind: InvoiceCheckoutKind; amountMinor: bigint }
  /** Not decidable yet (a refund before its payment was recorded): 503. */
  retryLater?: boolean
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

const MINTED_MINOR = /^\d{1,15}$/

/**
 * What a session was minted to collect (s216b `hub_payment_minor`); a session
 * minted before deposits has none and collected the full total. Malformed =
 * null (never confirmed).
 */
function mintedAmountMinor(
  minted: string | undefined,
  invoice: Pick<InvoiceModel, "total" | "currency">,
): bigint | null {
  if (minted === undefined) {
    return decimalStringToMinor(invoice.total, invoice.currency)
  }
  return MINTED_MINOR.test(minted) ? BigInt(minted) : null
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
  // The hub only mints one-time payment sessions.
  if (session.mode !== "payment") {
    return UNRESOLVED
  }
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
      sessionId: session.id,
    }
  }
  // s216b: the session names what it collects. A session minted before
  // deposits existed carries neither key: it collected the full total.
  const kind = invoiceCheckoutKinds.safeParse(
    session.metadata?.hub_payment_kind ?? "full",
  )
  const expectedMinor = mintedAmountMinor(
    session.metadata?.hub_payment_minor,
    hubInvoice,
  )
  const paidAsMinted =
    kind.success &&
    expectedMinor !== null &&
    session.payment_status === "paid" &&
    session.amount_total !== null &&
    BigInt(session.amount_total) === expectedMinor &&
    session.currency?.toLowerCase() === hubInvoice.currency.toLowerCase()
  if (session.payment_status === "paid" && !paidAsMinted) {
    logger.error(
      { eventId: event.id, invoiceId: hubInvoice.id, sessionId: session.id },
      "stripe webhook: checkout session paid an amount it was not minted for",
    )
  }
  return {
    hubInvoice,
    confirmed: paidAsMinted && !!paymentIntentId,
    failedWhileOpen: false,
    paymentIntentId,
    sessionId: session.id,
    ...(paidAsMinted && kind.success && expectedMinor !== null
      ? { payment: { kind: kind.data, amountMinor: expectedMinor } }
      : {}),
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
  if (hubInvoice?.status === "open" && !hubInvoice.providerInvoiceId) {
    // Refunded before the payment event was applied (that one is still in
    // Stripe's retry queue): decide once the invoice is paid, never drop it.
    // Only while the invoice can still become paid: a refund of a payment a
    // void invoice never took (the flagged duplicate) is final, not retried.
    return { ...UNRESOLVED, hubInvoice, retryLater: true }
  }
  if (hubInvoice && (await isSplitPayment(hubInvoice))) {
    // s216b: one of several payments (a deposit, or the balance after one)
    // was refunded. `refunded` means the whole invoice; flag it instead.
    await db
      .update(invoiceModel)
      .set({
        lastError: `Payment ${paymentIntentId} of this ${hubInvoice.status} invoice was refunded in Stripe; the invoice keeps its status: check it`,
        updatedAt: new Date(),
      })
      .where(eq(invoiceModel.id, hubInvoice.id))
    return UNRESOLVED
  }
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

/** The refunded payment is one of an invoice's several (s216b deposits). */
async function isSplitPayment(invoice: InvoiceModel): Promise<boolean> {
  if (invoice.status === "partiallyPaid") {
    return true
  }
  const payments = await db
    .select({ id: invoicePaymentModel.id })
    .from(invoicePaymentModel)
    .where(eq(invoicePaymentModel.invoiceId, invoice.id))
    .limit(2)
  return payments.length > 1
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

/** InvoiceEvent outcome of the checkout payment whose marks + emit ran. */
const MARKED_OUTCOME = "marked"

/** Drop an event's dedup row so Stripe's redelivery is processed again. */
async function dropDedupRow(
  credentials: StripeCredentials,
  eventId: string,
): Promise<void> {
  try {
    await db
      .delete(invoiceEventModel)
      .where(
        and(
          eq(invoiceEventModel.integrationId, credentials.integrationId),
          eq(invoiceEventModel.providerEventId, eventId),
        ),
      )
  } catch (error) {
    // The redelivery will now read as a duplicate: say so, loudly.
    logger.error(
      { err: error, eventId },
      "stripe webhook: dedup row not removed; this event's redelivery will be skipped",
    )
  }
}

/**
 * An async payment on the invoice's recorded session failed: that session
 * stays `complete` at Stripe forever, so free the link (the next visit
 * mints a fresh session) instead of answering "processing" for good.
 */
async function releaseFailedSession(
  hubInvoice: InvoiceModel,
  sessionId: string | undefined,
): Promise<void> {
  if (!sessionId || hubInvoice.checkoutSessionId !== sessionId) {
    return
  }
  await db
    .update(invoiceModel)
    .set({
      checkoutSessionId: null,
      checkoutMintedAt: null,
      checkoutGeneration: hubInvoice.checkoutGeneration + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invoiceModel.id, hubInvoice.id),
        inArray(invoiceModel.status, ["open", "partiallyPaid"]),
        eq(invoiceModel.checkoutSessionId, sessionId),
      ),
    )
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
}): Promise<
  | { kind: "remark"; row: InvoiceModel }
  | { kind: "already-marked" }
  | { kind: "duplicate-payment" }
> {
  const { credentials, event, hubInvoice, paymentIntentId } = props
  const [current] = await db
    .select()
    .from(invoiceModel)
    .where(eq(invoiceModel.id, hubInvoice.id))
    .limit(1)
  if (current?.providerInvoiceId === paymentIntentId) {
    const marked = await db.query.invoiceEventModel.findFirst({
      where: { invoiceId: current.id, outcome: MARKED_OUTCOME },
      columns: { id: true },
    })
    return marked
      ? { kind: "already-marked" }
      : { kind: "remark", row: current }
  }
  await flagUnappliedPayment({
    credentials,
    event,
    invoiceId: hubInvoice.id,
    message: `A second payment (${paymentIntentId}) reached this ${current?.status ?? "unknown"} invoice: refund it in Stripe`,
  })
  return { kind: "duplicate-payment" }
}

/**
 * Record a confirmed payment the invoice did not take: the event's outcome
 * says so and `lastError` tells the operator to refund it. Never applied.
 */
async function flagUnappliedPayment(props: {
  credentials: StripeCredentials
  event: Stripe.Event
  invoiceId: string
  message: string
}): Promise<void> {
  const { credentials, event } = props
  logger.error(
    { eventId: event.id, invoiceId: props.invoiceId, detail: props.message },
    "stripe webhook: a checkout payment was not applied; refund it in Stripe",
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
      .set({ lastError: props.message, updatedAt: new Date() })
      .where(eq(invoiceModel.id, props.invoiceId))
  })
}

/**
 * After a checkout payment's transaction (s216b): flag a rejected payment, or
 * run the contact marks + event of an applied / known one exactly once (the
 * InvoicePayment `markedAt` claim; the two events of one payment race for it).
 */
async function settleCheckoutPayment(props: {
  credentials: StripeCredentials
  event: Stripe.Event
  hubInvoice: InvoiceModel
  paymentIntentId: string
  result: Exclude<AppliedPayment, { kind: "legacyKnown" }>
}): Promise<StripeWebhookResult> {
  const { credentials, event, result } = props
  if (result.kind === "rejected") {
    try {
      await flagUnappliedPayment({
        credentials,
        event,
        invoiceId: props.hubInvoice.id,
        message: `A payment (${props.paymentIntentId}) reached this ${result.row?.status ?? "unknown"} invoice and was not applied (${result.reason}): refund it in Stripe`,
      })
    } catch (error) {
      await dropDedupRow(credentials, event.id)
      logger.error(
        { err: error, eventId: event.id, invoiceId: props.hubInvoice.id },
        "stripe webhook: could not flag an unapplied checkout payment, asking Stripe to redeliver",
      )
      return { outcome: "retry", detail: "duplicate-payment flag" }
    }
    return { outcome: "noop", detail: "duplicate-payment" }
  }
  const { row, payment } = result
  let claimed: boolean
  try {
    claimed = await claimPaymentMarks(payment.id)
  } catch (error) {
    await dropDedupRow(credentials, event.id)
    logger.error(
      { err: error, eventId: event.id },
      "stripe webhook: could not claim the payment marks, asking Stripe to redeliver",
    )
    return { outcome: "retry", detail: "marks claim" }
  }
  if (!claimed) {
    return { outcome: "noop", detail: "already-marked" }
  }
  // A deposit whose marks run after the balance already paid the invoice
  // must not write `partiallyPaid` over `paid`: the paid marks cover it.
  const status =
    payment.kind === "deposit" && row.status !== "partiallyPaid"
      ? null
      : row.status
  try {
    if (status === "paid" || status === "partiallyPaid") {
      await markInvoiceOnContact({ invoice: row, status })
      const emit =
        status === "paid" ? emitInvoicePaid : emitInvoicePartiallyPaid
      await emit(row.workspaceId, row.contactId, invoiceEventMetadata(row))
    }
  } catch (error) {
    await releasePaymentMarks(payment.id).catch((releaseError: unknown) =>
      logger.error(
        { err: releaseError, paymentId: payment.id },
        "stripe webhook: payment marks not released; the redelivery will skip them",
      ),
    )
    await dropDedupRow(credentials, event.id)
    logger.warn(
      { err: error, eventId: event.id, invoiceId: row.id },
      "stripe webhook: contact marks failed, asking Stripe to redeliver",
    )
    return { outcome: "retry", detail: "contact marks" }
  }
  if (status) {
    // Not awaited: Gotenberg must not hold Stripe's delivery open.
    prerenderInvoiceReceipt(row.id).catch(() => undefined)
  }
  if (result.kind === "applied") {
    await enqueueInvoiceMirror(row)
  }
  return {
    outcome: result.kind === "applied" ? "applied" : "noop",
    detail: `${event.type} invoice ${row.id} ${payment.kind}`,
  }
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
    // Only a Stripe answer about the object (a 404, a bad request) may be
    // recorded as final; a database blip or a bug must never drop a payment.
    if (!(error instanceof StripeSdk.errors.StripeError)) {
      logger.error(
        { err: error, eventId: event.id },
        "stripe webhook: resolution failed, asking Stripe to redeliver",
      )
      return { outcome: "retry", detail: "resolution failed" }
    }
    // A rolled, revoked or under-scoped key: the event is real (its
    // signature checked out) but cannot be confirmed. Recording it would
    // drop it for good; keep Stripe redelivering until Stripe is reconnected.
    if (
      error instanceof StripeSdk.errors.StripeAuthenticationError ||
      error instanceof StripeSdk.errors.StripePermissionError
    ) {
      logger.error(
        { err: error, eventId: event.id },
        "stripe webhook: the stored key cannot read Stripe; reconnect Stripe",
      )
      return { outcome: "retry", detail: "stripe key rejected" }
    }
    logger.warn(
      { err: error, eventId: event.id },
      "stripe webhook: invoice lookup failed",
    )
  }
  if (resolution.retryLater) {
    return { outcome: "retry", detail: "payment not recorded yet" }
  }
  let { hubInvoice } = resolution
  const { confirmed, paymentIntentId } = resolution

  let applied = null as InvoiceModel | null
  let checkoutPayment = null as AppliedPayment | null
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
      if (resolution.payment && paymentIntentId && target === "paid") {
        checkoutPayment = await applyCheckoutPayment(tx, {
          invoiceId: hubInvoice.id,
          kind: resolution.payment.kind,
          amountMinor: resolution.payment.amountMinor,
          paymentIntentId,
          now,
        })
        applied =
          checkoutPayment.kind === "applied" ? checkoutPayment.row : null
        return
      }
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

  if (event.type === "checkout.session.async_payment_failed") {
    await releaseFailedSession(hubInvoice, resolution.sessionId)
  }
  if (
    checkoutPayment &&
    checkoutPayment.kind !== "legacyKnown" &&
    paymentIntentId
  ) {
    return await settleCheckoutPayment({
      credentials,
      event,
      hubInvoice,
      paymentIntentId,
      result: checkoutPayment,
    })
  }
  // A charge.refunded of a checkout payment, or the redelivery of a payment
  // recorded before s216b (no InvoicePayment row): the pre-s216b path.
  const checkoutPaid = target === "paid" && !!paymentIntentId
  if (checkoutPaid && !applied && paymentIntentId) {
    let settled: Awaited<ReturnType<typeof settleUnappliedCheckoutPayment>>
    try {
      settled = await settleUnappliedCheckoutPayment({
        credentials,
        event,
        hubInvoice,
        paymentIntentId,
      })
    } catch (error) {
      // The flag must not be lost: let Stripe redeliver and flag again.
      await dropDedupRow(credentials, event.id)
      logger.error(
        { err: error, eventId: event.id, invoiceId: hubInvoice.id },
        "stripe webhook: could not flag an unapplied checkout payment, asking Stripe to redeliver",
      )
      return { outcome: "retry", detail: "duplicate-payment flag" }
    }
    if (settled.kind !== "remark") {
      return { outcome: "noop", detail: settled.kind }
    }
    hubInvoice = settled.row
  }

  if (checkoutPaid) {
    // Two event types can carry one checkout payment (completed and
    // async_payment_succeeded): claim the marks for THIS event before they
    // run, so the other one reads "already marked". A failed claim retries
    // before anything is emitted; a failed mark drops the row (and the claim).
    try {
      await db
        .update(invoiceEventModel)
        .set({ outcome: MARKED_OUTCOME, updatedAt: new Date() })
        .where(
          and(
            eq(invoiceEventModel.integrationId, credentials.integrationId),
            eq(invoiceEventModel.providerEventId, event.id),
          ),
        )
    } catch (error) {
      await dropDedupRow(credentials, event.id)
      logger.error(
        { err: error, eventId: event.id },
        "stripe webhook: could not claim the payment marks, asking Stripe to redeliver",
      )
      return { outcome: "retry", detail: "marks claim" }
    }
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
    await dropDedupRow(credentials, event.id)
    logger.warn(
      { err: error, eventId: event.id, invoiceId: hubInvoice.id },
      "stripe webhook: contact marks failed, asking Stripe to redeliver",
    )
    return { outcome: "retry", detail: "contact marks" }
  }
  if (checkoutPaid) {
    // Not awaited: Gotenberg must not hold Stripe's delivery open. It
    // never rejects (it logs its own failure); the catch is belt and braces.
    prerenderInvoiceReceipt(hubInvoice.id).catch(() => undefined)
  }
  if (applied) {
    await enqueueInvoiceMirror(applied)
  }
  return {
    outcome: applied ? "applied" : "noop",
    detail: `${event.type} invoice ${hubInvoice.id}`,
  }
}
