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
import { appendLastError } from "./last-error"

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

/**
 * THIS caller's marks ran: no later delivery may run them again. False when
 * the claim was taken over meanwhile (this run outlived the lease, so the
 * marks may have run twice): the caller logs it.
 */
export async function finishPaymentMarks(
  paymentId: string,
  claimedAt: Date,
): Promise<boolean> {
  const at = new Date()
  const [done] = await db
    .update(invoicePaymentModel)
    .set({ marksDoneAt: at, updatedAt: at })
    .where(
      and(
        eq(invoicePaymentModel.id, paymentId),
        eq(invoicePaymentModel.markedAt, claimedAt),
      ),
    )
    .returning({ id: invoicePaymentModel.id })
  return !!done
}

export type AppliedRefund =
  /** Recorded now: the invoice moved from `from` to `row.status` (maybe the same). */
  | {
      kind: "applied"
      row: InvoiceModel
      payment: InvoicePaymentModel
      from: InvoiceModel["status"]
    }
  /** This payment's refund was recorded before (a redelivery). */
  | { kind: "known"; row: InvoiceModel }
  /** The invoice is gone. */
  | { kind: "unknownInvoice"; row: null }

/** Statuses a refund may roll back; any other keeps its status (a note only). */
const ROLLBACK_FROM: readonly InvoiceModel["status"][] = [
  "paid",
  "partiallyPaid",
]

/**
 * s235 (owner: "roll back what's owed"): Stripe refunded ONE payment of a
 * deposit invoice in full. Under the invoice's row lock, the payment is
 * marked refunded, `amountPaid` becomes the sum of the payments still held,
 * and a paid / partly paid invoice's status follows it:
 * - nothing held: `refunded` when the invoice was once fully paid, else `open`
 *   (a refunded deposit: the pay link offers the deposit again);
 * - part held: `partiallyPaid` (the pay link collects the rest as a balance);
 * - the total held: `paid`.
 * The pay session is spent either way, and an operator note is appended.
 *
 * A PaymentIntent the ledger never recorded (a rejected duplicate, or one
 * whose payment event is still in Stripe's retry queue) is recorded now as
 * an already-refunded row: it holds nothing, and its late payment event
 * reads "known" and is never applied (it is never retried here either: a
 * rejected payment would never arrive and the refund would be lost).
 */
export async function applyCheckoutRefund(
  tx: Tx,
  props: {
    invoiceId: string
    paymentIntentId: string
    /** What the PaymentIntent was minted to collect (its hub metadata). */
    minted: { kind: InvoiceCheckoutKind; amountMinor: bigint }
    now: Date
  },
): Promise<AppliedRefund> {
  const [row] = await tx
    .select()
    .from(invoiceModel)
    .where(eq(invoiceModel.id, props.invoiceId))
    .for("update")
  if (!row) {
    return { kind: "unknownInvoice", row: null }
  }
  const payments = await tx
    .select()
    .from(invoicePaymentModel)
    .where(eq(invoicePaymentModel.invoiceId, row.id))
  const known = payments.find(
    (p) => p.providerPaymentId === props.paymentIntentId,
  )
  if (known?.refundedAt) {
    return { kind: "known", row }
  }
  if (!known) {
    const [marker] = await tx
      .insert(invoicePaymentModel)
      .values({
        workspaceId: row.workspaceId,
        invoiceId: row.id,
        kind: props.minted.kind,
        amount: minorToDecimalString(props.minted.amountMinor, row.currency),
        providerPaymentId: props.paymentIntentId,
        paidAt: props.now,
        refundedAt: props.now,
        // Nothing to mark: the invoice never took this payment.
        markedAt: props.now,
        marksDoneAt: props.now,
      })
      .returning()
    const [noted] = await tx
      .update(invoiceModel)
      .set({
        lastError: appendLastError(
          `Payment ${props.paymentIntentId} was refunded in Stripe before this ${row.status} invoice recorded it: it is never applied`,
        ),
        updatedAt: props.now,
      })
      .where(eq(invoiceModel.id, row.id))
      .returning()
    if (!(marker && noted)) {
      throw new Error("invoice refund: marker insert returned no row")
    }
    return { kind: "applied", row: noted, payment: marker, from: row.status }
  }
  const heldMinor = payments
    .filter((p) => p.id !== known.id && !p.refundedAt)
    .reduce((sum, p) => sum + minor(row, p.amount), 0n)
  const rollsBack = ROLLBACK_FROM.includes(row.status)
  let status = row.status
  if (rollsBack) {
    status = "partiallyPaid"
    if (heldMinor === 0n) {
      status = row.paidAt ? "refunded" : "open"
    } else if (heldMinor >= minor(row, row.total)) {
      status = "paid"
    }
  }
  const [refunded] = await tx
    .update(invoicePaymentModel)
    .set({ refundedAt: props.now, updatedAt: props.now })
    .where(eq(invoicePaymentModel.id, known.id))
    .returning()
  const [updated] = await tx
    .update(invoiceModel)
    .set({
      ...(rollsBack
        ? {
            status,
            amountPaid: minorToDecimalString(heldMinor, row.currency),
            checkoutSessionId: null,
            checkoutMintedAt: null,
            checkoutKind: null,
            checkoutGeneration: row.checkoutGeneration + 1,
          }
        : {}),
      lastError: appendLastError(
        rollsBack
          ? `Payment ${known.providerPaymentId} (${known.kind} ${known.amount}) was refunded in Stripe: the invoice moved ${row.status} -> ${status}`
          : `Payment ${known.providerPaymentId} (${known.kind} ${known.amount}) was refunded in Stripe; this ${row.status} invoice keeps its status: check it`,
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
