import { and, db, eq, isNull, lt, or } from "@chatbotx.io/database/client"
import {
  decimalStringToMinor,
  type InvoiceCheckoutKind,
  invoiceCheckoutKinds,
  minorToDecimalString,
} from "@chatbotx.io/database/partials"
import { invoiceModel, invoicePaymentModel } from "@chatbotx.io/database/schema"
import type {
  InvoiceModel,
  InvoicePaymentModel,
} from "@chatbotx.io/database/types"

/**
 * Deposits (s216b). A stripeCheckout invoice with a `depositAmount` can be
 * paid in two steps (deposit, then balance) or at once (full). Every payment
 * is an InvoicePayment row; `Invoice.amountPaid` is their sum. The row lock
 * taken in `applyCheckoutPayment` serialises every payment of one invoice.
 */

type PayableInvoice = Pick<
  InvoiceModel,
  "status" | "total" | "currency" | "depositAmount" | "amountPaid"
>

/** What the pay link collects next: a kind, or ask the person first. */
export type NextCheckout =
  | { kind: InvoiceCheckoutKind }
  | { kind: "choose"; depositMinor: bigint; totalMinor: bigint }
  | null

const minor = (invoice: Pick<InvoiceModel, "currency">, value: string) =>
  decimalStringToMinor(value, invoice.currency)

/** Minor units still owed. */
export const amountDueMinor = (
  invoice: Pick<InvoiceModel, "total" | "currency" | "amountPaid">,
): bigint => minor(invoice, invoice.total) - minor(invoice, invoice.amountPaid)

/**
 * The kind a visit collects. A partly paid invoice only takes its balance;
 * an open invoice with a deposit takes what the person picked (`requested`),
 * or asks; anything else is paid in full. Null = nothing is payable.
 */
export function nextCheckout(
  invoice: PayableInvoice,
  requested: unknown,
): NextCheckout {
  if (invoice.status === "partiallyPaid") {
    return { kind: "balance" }
  }
  if (invoice.status !== "open") {
    return null
  }
  if (!invoice.depositAmount) {
    return { kind: "full" }
  }
  const parsed = invoiceCheckoutKinds.safeParse(requested)
  if (parsed.success && parsed.data !== "balance") {
    return { kind: parsed.data }
  }
  return {
    kind: "choose",
    depositMinor: minor(invoice, invoice.depositAmount),
    totalMinor: minor(invoice, invoice.total),
  }
}

/**
 * Minor units a session of `kind` must collect from the invoice as it
 * stands, or null when that kind is not payable now.
 */
export function checkoutAmountMinor(
  invoice: PayableInvoice,
  kind: InvoiceCheckoutKind,
): bigint | null {
  const paid = minor(invoice, invoice.amountPaid)
  if (kind === "deposit") {
    if (invoice.status !== "open" || !invoice.depositAmount || paid !== 0n) {
      return null
    }
    return minor(invoice, invoice.depositAmount)
  }
  if (kind === "full") {
    return invoice.status === "open" && paid === 0n
      ? minor(invoice, invoice.total)
      : null
  }
  return invoice.status === "partiallyPaid" ? amountDueMinor(invoice) : null
}

export type AppliedPayment =
  /** Recorded now: the invoice moved to `row.status`. */
  | { kind: "applied"; row: InvoiceModel; payment: InvoicePaymentModel }
  /** This PaymentIntent was recorded before (the other event type, a redelivery). */
  | { kind: "known"; row: InvoiceModel; payment: InvoicePaymentModel }
  /** Paid before s216b (no payment rows): this PaymentIntent is the recorded one. */
  | { kind: "legacyKnown"; row: InvoiceModel }
  /** The invoice cannot take it (void, already paid, another amount): flag it. */
  | { kind: "rejected"; row: InvoiceModel | null; reason: string }

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Record one confirmed checkout payment under the invoice's row lock. It is
 * applied only when it is exactly what the invoice owes for its kind right
 * now; a second deposit, a full payment after a deposit, or any payment on a
 * void or paid invoice is rejected (never applied, flagged by the caller).
 */
export async function applyCheckoutPayment(
  tx: Tx,
  props: {
    invoiceId: string
    kind: InvoiceCheckoutKind
    amountMinor: bigint
    paymentIntentId: string
    now: Date
  },
): Promise<AppliedPayment> {
  const [row] = await tx
    .select()
    .from(invoiceModel)
    .where(eq(invoiceModel.id, props.invoiceId))
    // A caller that also inserts a row referencing this invoice (the
    // webhook's InvoiceEvent) must take this lock FIRST: that FK insert holds
    // KEY SHARE, and two such holders asking FOR UPDATE deadlock (s216b H1).
    .for("update")
  if (!row) {
    return { kind: "rejected", row: null, reason: "no such invoice" }
  }
  const [known] = await tx
    .select()
    .from(invoicePaymentModel)
    .where(
      and(
        eq(invoicePaymentModel.invoiceId, row.id),
        eq(invoicePaymentModel.providerPaymentId, props.paymentIntentId),
      ),
    )
    .limit(1)
  if (known) {
    return { kind: "known", row, payment: known }
  }
  if (row.providerInvoiceId === props.paymentIntentId) {
    return { kind: "legacyKnown", row }
  }
  const owed = checkoutAmountMinor(row, props.kind)
  if (owed === null || owed !== props.amountMinor) {
    return {
      kind: "rejected",
      row,
      reason:
        owed === null
          ? `a ${props.kind} payment is not payable on this ${row.status} invoice`
          : `a ${props.kind} payment of ${props.amountMinor} does not match the ${owed} owed`,
    }
  }
  const paidMinor = minor(row, row.amountPaid) + props.amountMinor
  const fullyPaid = paidMinor === minor(row, row.total)
  const [payment] = await tx
    .insert(invoicePaymentModel)
    .values({
      workspaceId: row.workspaceId,
      invoiceId: row.id,
      kind: props.kind,
      amount: minorToDecimalString(props.amountMinor, row.currency),
      providerPaymentId: props.paymentIntentId,
      paidAt: props.now,
    })
    .returning()
  const [updated] = await tx
    .update(invoiceModel)
    .set({
      status: fullyPaid ? "paid" : "partiallyPaid",
      amountPaid: minorToDecimalString(paidMinor, row.currency),
      ...(fullyPaid ? { paidAt: props.now } : {}),
      // The latest payment; a full refund of it is what `refunded` means.
      providerInvoiceId: props.paymentIntentId,
      // The paid session is spent: the next visit mints the balance session
      // (or shows "paid"), and a minter still holding this generation loses.
      checkoutSessionId: null,
      checkoutMintedAt: null,
      checkoutKind: null,
      checkoutGeneration: row.checkoutGeneration + 1,
      // lastError is kept: a "refund it" flag from a rejected payment must
      // survive the next applied one (s216b probe H3).
      updatedAt: props.now,
    })
    .where(eq(invoiceModel.id, row.id))
    .returning()
  if (!(payment && updated)) {
    throw new Error("invoice payment: insert or update returned no row")
  }
  return { kind: "applied", row: updated, payment }
}

/**
 * A marks claim older than this with no `marksDoneAt` belongs to a run that
 * died after its claim (s235): the next delivery may claim it again. The
 * marks are a few row writes, so a live run never holds a claim this long.
 */
export const PAYMENT_MARKS_LEASE_MS = 10 * 60 * 1000

/** The ledger row of one PaymentIntent on one invoice, if recorded. */
export async function findCheckoutPayment(
  invoiceId: string,
  paymentIntentId: string,
): Promise<InvoicePaymentModel | null> {
  const [row] = await db
    .select()
    .from(invoicePaymentModel)
    .where(
      and(
        eq(invoicePaymentModel.invoiceId, invoiceId),
        eq(invoicePaymentModel.providerPaymentId, paymentIntentId),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Claim a payment's marks: the claim's timestamp (this caller runs them), or
 * null when another caller holds a live claim or the marks are done. A claim
 * past `PAYMENT_MARKS_LEASE_MS` that never finished is taken over (s235: a
 * crash between the claim and `finishPaymentMarks` lost the marks for good).
 */
export async function claimPaymentMarks(
  paymentId: string,
): Promise<Date | null> {
  const at = new Date()
  const stale = new Date(at.getTime() - PAYMENT_MARKS_LEASE_MS)
  const [claimed] = await db
    .update(invoicePaymentModel)
    .set({ markedAt: at, updatedAt: at })
    .where(
      and(
        eq(invoicePaymentModel.id, paymentId),
        isNull(invoicePaymentModel.marksDoneAt),
        or(
          isNull(invoicePaymentModel.markedAt),
          lt(invoicePaymentModel.markedAt, stale),
        ),
      ),
    )
    .returning({ id: invoicePaymentModel.id })
  return claimed ? at : null
}

/** THIS caller's marks ran: no later delivery may run them again. */
export async function finishPaymentMarks(
  paymentId: string,
  claimedAt: Date,
): Promise<void> {
  const at = new Date()
  await db
    .update(invoicePaymentModel)
    .set({ marksDoneAt: at, updatedAt: at })
    .where(
      and(
        eq(invoicePaymentModel.id, paymentId),
        eq(invoicePaymentModel.markedAt, claimedAt),
      ),
    )
}

export type AppliedRefund =
  /** Recorded now: the invoice moved from `from` to `row.status`. */
  | {
      kind: "applied"
      row: InvoiceModel
      payment: InvoicePaymentModel
      from: InvoiceModel["status"]
    }
  /** This payment's refund was recorded before (a redelivery). */
  | { kind: "known"; row: InvoiceModel }
  /** No ledger row for that PaymentIntent on this invoice. */
  | { kind: "unknownPayment"; row: InvoiceModel | null }

/** `lastError` keeps earlier operator notes (a "refund it" flag); bounded. */
const LAST_ERROR_MAX = 2000
const appendNote = (previous: string | null, note: string) => {
  const joined = previous ? `${previous} | ${note}` : note
  return joined.length > LAST_ERROR_MAX
    ? joined.slice(joined.length - LAST_ERROR_MAX)
    : joined
}

/**
 * s235 (owner: "roll back what's owed"): Stripe refunded ONE payment of a
 * deposit invoice in full. Under the invoice's row lock, the payment is
 * marked refunded, `amountPaid` becomes the sum of the payments still held,
 * and the status follows it:
 * - nothing held: `refunded` when the invoice was once fully paid, else `open`
 *   (a refunded deposit: the pay link offers the deposit again);
 * - part held: `partiallyPaid` (the pay link collects the rest as a balance);
 * - the total held: `paid`.
 * The pay session is spent either way, and an operator note is appended.
 */
export async function applyCheckoutRefund(
  tx: Tx,
  props: { invoiceId: string; paymentIntentId: string; now: Date },
): Promise<AppliedRefund> {
  const [row] = await tx
    .select()
    .from(invoiceModel)
    .where(eq(invoiceModel.id, props.invoiceId))
    .for("update")
  if (!row) {
    return { kind: "unknownPayment", row: null }
  }
  const payments = await tx
    .select()
    .from(invoicePaymentModel)
    .where(eq(invoicePaymentModel.invoiceId, row.id))
  const payment = payments.find(
    (p) => p.providerPaymentId === props.paymentIntentId,
  )
  if (!payment) {
    return { kind: "unknownPayment", row }
  }
  if (payment.refundedAt) {
    return { kind: "known", row }
  }
  const heldMinor = payments
    .filter((p) => p.id !== payment.id && !p.refundedAt)
    .reduce((sum, p) => sum + minor(row, p.amount), 0n)
  const totalMinor = minor(row, row.total)
  let status: InvoiceModel["status"] = "partiallyPaid"
  if (heldMinor === 0n) {
    status = row.paidAt ? "refunded" : "open"
  } else if (heldMinor >= totalMinor) {
    status = "paid"
  }
  const [refunded] = await tx
    .update(invoicePaymentModel)
    .set({ refundedAt: props.now, updatedAt: props.now })
    .where(eq(invoicePaymentModel.id, payment.id))
    .returning()
  const [updated] = await tx
    .update(invoiceModel)
    .set({
      status,
      amountPaid: minorToDecimalString(heldMinor, row.currency),
      checkoutSessionId: null,
      checkoutMintedAt: null,
      checkoutKind: null,
      checkoutGeneration: row.checkoutGeneration + 1,
      lastError: appendNote(
        row.lastError,
        `Payment ${payment.providerPaymentId} (${payment.kind} ${payment.amount}) was refunded in Stripe: the invoice moved ${row.status} -> ${status}`,
      ),
      updatedAt: props.now,
    })
    .where(eq(invoiceModel.id, row.id))
    .returning()
  if (!(refunded && updated)) {
    throw new Error("invoice refund: update returned no row")
  }
  return { kind: "applied", row: updated, payment: refunded, from: row.status }
}

/** Hand back THIS caller's claim after its marks failed, so a redelivery runs them. */
export async function releasePaymentMarks(
  paymentId: string,
  claimedAt: Date,
): Promise<void> {
  await db
    .update(invoicePaymentModel)
    .set({ markedAt: null, updatedAt: new Date() })
    .where(
      and(
        eq(invoicePaymentModel.id, paymentId),
        eq(invoicePaymentModel.markedAt, claimedAt),
      ),
    )
}
