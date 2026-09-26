import { createHash } from "node:crypto"
import {
  and,
  db,
  desc,
  eq,
  exists,
  gt,
  inArray,
  like,
  lt,
  ne,
  or,
  type SQL,
  sql,
} from "@chatbotx.io/database/client"
import {
  INVOICE_STATUS_TRANSITIONS,
  type InvoiceStatus,
  minorToDecimalString,
  normalizeInvoiceCurrency,
  parseMoneyToMinor,
} from "@chatbotx.io/database/partials"
import {
  contactModel,
  conversationModel,
  dealModel,
  invoiceLineItemModel,
  invoiceModel,
} from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import {
  emitInvoiceCreated,
  type InvoiceEventMetadata,
} from "@chatbotx.io/events"
import { BaseService } from "../base.service"
import {
  ChatbotXException,
  notFoundException,
  validationException,
} from "../errors"
import { integrationStripeService } from "../integration-stripe/service"
import { logger } from "../logger"
import {
  type CreateInvoiceInput,
  createInvoiceInputSchema,
  type InvoiceRef,
  invoiceRefSchema,
  type ListInvoicesInput,
  listInvoicesInputSchema,
} from "./schema"
import {
  finalizeWithStripe,
  InvoiceProviderError,
  STRIPE_MAX_AMOUNT_MINOR,
  voidWithStripe,
} from "./stripe-provider"

export type InvoiceWithLines = InvoiceModel & {
  lineItems: InvoiceLineItemModel[]
}

export const invoiceEventMetadata = (
  invoice: InvoiceModel,
): InvoiceEventMetadata => ({
  invoiceId: invoice.id,
  number: invoice.number,
  status: invoice.status,
  method: invoice.method,
  total: invoice.total,
  currency: invoice.currency,
  hostedUrl: invoice.hostedUrl,
  dealId: invoice.dealId,
})

/** The same idempotency key replayed with different content: never billed. */
export const idempotencyConflictException = () =>
  new ChatbotXException(
    "This idempotency key was already used for a different invoice",
    "conflict",
    409,
  )

/**
 * What a sourceKey replay must match to return the first invoice: the
 * NORMALISED request (currency upper-cased, amounts as stored strings).
 */
export const invoiceRequestHash = (request: {
  contactId: string
  currency: string
  lines: { description: string; quantity: number; unitAmount: string }[]
  dueDays: number
  memo?: string
  dealId?: string
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        request.contactId,
        request.currency,
        request.lines.map((l) => [l.description, l.quantity, l.unitAmount]),
        request.dueDays,
        request.memo ?? "",
        request.dealId ?? "",
      ]),
    )
    .digest("hex")

/** Stripe status after finalize -> hub status; anything else is an error. */
const FINALIZED_STATUS: Partial<Record<string, InvoiceStatus>> = {
  open: "open",
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
}

/** A provider failure surfaced to callers: `retryable` = a job may retry. */
export class InvoiceFinalizeError extends ChatbotXException {
  readonly retryable: boolean
  readonly invoice: InvoiceModel

  constructor(message: string, retryable: boolean, invoice: InvoiceModel) {
    super(message, "invoiceFinalizeFailed")
    this.retryable = retryable
    this.invoice = invoice
  }
}

const DAY_MS = 86_400_000
const LIST_CURSOR_SEPARATOR = "_"

/** Keyset cursor: createdAt in epoch MICROseconds + id (never ::text). */
const encodeCursor = (row: { createdAtMicros: string; id: string }) =>
  `${row.createdAtMicros}${LIST_CURSOR_SEPARATOR}${row.id}`

/** Built per call: a module-level `sql` would break a mocked client in tests. */
const createdAtMicros = () =>
  sql<string>`(extract(epoch from ${invoiceModel.createdAt}) * 1000000)::bigint::text`

/**
 * The assigned-only rule (s193/s195) for an invoice read: the invoice's
 * contact must have a conversation assigned to the caller. Undefined =
 * unrestricted (admins, workers, the public API).
 */
function assignedOnlySQL(userId?: string): SQL | undefined {
  if (!userId) {
    return
  }
  return exists(
    db
      .select({ one: sql`1` })
      .from(conversationModel)
      .where(
        and(
          eq(conversationModel.contactId, invoiceModel.contactId),
          eq(conversationModel.assignedUserId, userId),
        ),
      ),
  )
}

/**
 * Hub invoices (s205b). Write order: the row + its lines in one transaction
 * (numbering and sourceKey idempotency serialised by a per-workspace advisory
 * lock), THEN the provider, THEN the event. A provider failure leaves the row
 * `draft` with `lastError`; `finalize` resumes it.
 */
class InvoiceService extends BaseService {
  async get(ref: InvoiceRef): Promise<InvoiceWithLines> {
    const { workspaceId, id, restrictToAssignedUserId } =
      invoiceRefSchema.parse(ref)
    const scope = assignedOnlySQL(restrictToAssignedUserId)
    if (scope) {
      const [visible] = await db
        .select({ id: invoiceModel.id })
        .from(invoiceModel)
        .where(
          and(
            eq(invoiceModel.id, id),
            eq(invoiceModel.workspaceId, workspaceId),
            scope,
          ),
        )
        .limit(1)
      if (!visible) {
        throw notFoundException("Invoice not found")
      }
    }
    const invoice = await db.query.invoiceModel.findFirst({
      where: { id, workspaceId },
      with: { lineItems: { orderBy: { position: "asc" } } },
    })
    if (!invoice) {
      throw notFoundException("Invoice not found")
    }
    return invoice
  }

  async list(input: ListInvoicesInput): Promise<{
    data: InvoiceModel[]
    nextCursor: string | null
  }> {
    const props = listInvoicesInputSchema.parse(input)
    const filters: SQL[] = [eq(invoiceModel.workspaceId, props.workspaceId)]
    if (props.contactId) {
      filters.push(eq(invoiceModel.contactId, props.contactId))
    }
    if (props.status) {
      filters.push(eq(invoiceModel.status, props.status))
    }
    const scope = assignedOnlySQL(props.restrictToAssignedUserId)
    if (scope) {
      filters.push(scope)
    }
    if (props.cursor) {
      const [micros, id] = props.cursor.split(LIST_CURSOR_SEPARATOR) as [
        string,
        string,
      ]
      // Exact to the microsecond (to_timestamp goes through a double).
      const at = sql`(timestamptz 'epoch' + ${micros}::bigint * interval '1 microsecond')`
      filters.push(
        or(
          lt(invoiceModel.createdAt, at),
          and(eq(invoiceModel.createdAt, at), lt(invoiceModel.id, id)),
        ) as SQL,
      )
    }
    const rows = await db
      .select({ invoice: invoiceModel, createdAtMicros: createdAtMicros() })
      .from(invoiceModel)
      .where(and(...filters))
      .orderBy(desc(invoiceModel.createdAt), desc(invoiceModel.id))
      .limit(props.limit + 1)
    const page = rows.slice(0, props.limit)
    const last = page.at(-1)
    return {
      data: page.map((row) => row.invoice),
      nextCursor:
        rows.length > props.limit && last
          ? encodeCursor({
              createdAtMicros: last.createdAtMicros,
              id: last.invoice.id,
            })
          : null,
    }
  }

  /**
   * Create a hub invoice and collect it through the workspace's Stripe.
   * Idempotent on `sourceKey`: a replay returns the first invoice (resuming
   * its finalize when it is still a draft) and never creates a second one.
   */
  async create(input: CreateInvoiceInput): Promise<InvoiceWithLines> {
    const props = createInvoiceInputSchema.parse(input)
    const currency = normalizeInvoiceCurrency(props.currency)
    if (!currency) {
      throw validationException("currency", "Unsupported currency")
    }
    const lines = props.lines.map((line, index) => {
      const unitMinor = parseMoneyToMinor(line.unitAmount, currency)
      if (unitMinor === null || unitMinor <= 0n) {
        throw validationException(
          "lines",
          `Line ${index + 1}: the amount must be a positive ${currency} amount`,
        )
      }
      const amountMinor = unitMinor * BigInt(line.quantity)
      return {
        position: index,
        description: line.description,
        quantity: line.quantity,
        unitAmount: minorToDecimalString(unitMinor, currency),
        amountMinor,
      }
    })
    const totalMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0n)
    if (totalMinor > STRIPE_MAX_AMOUNT_MINOR) {
      throw validationException(
        "invoice",
        "The invoice total is larger than Stripe allows",
      )
    }
    const credentials =
      await integrationStripeService.credentialsByWorkspaceIdOrFail(
        props.workspaceId,
      )
    const requestHash = invoiceRequestHash({ ...props, currency, lines })

    const { invoice, created } = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`invoice:${props.workspaceId}`}, 0))`,
      )
      if (props.sourceKey) {
        const existing = await tx.query.invoiceModel.findFirst({
          where: { workspaceId: props.workspaceId, sourceKey: props.sourceKey },
        })
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw idempotencyConflictException()
          }
          return { invoice: existing, created: false }
        }
      }
      if (props.reuseRecent) {
        const [recent] = await tx
          .select()
          .from(invoiceModel)
          .where(
            and(
              eq(invoiceModel.workspaceId, props.workspaceId),
              eq(invoiceModel.contactId, props.contactId),
              like(
                invoiceModel.sourceKey,
                `${props.reuseRecent.sourcePrefix}%`,
              ),
              ne(invoiceModel.status, "void"),
              gt(
                invoiceModel.createdAt,
                new Date(Date.now() - props.reuseRecent.withinMs),
              ),
            ),
          )
          .orderBy(desc(invoiceModel.createdAt))
          .limit(1)
        if (recent) {
          return { invoice: recent, created: false }
        }
      }
      const [contact] = await tx
        .select({ id: contactModel.id, companyId: contactModel.companyId })
        .from(contactModel)
        .where(
          and(
            eq(contactModel.id, props.contactId),
            eq(contactModel.workspaceId, props.workspaceId),
          ),
        )
        .limit(1)
      if (!contact) {
        throw notFoundException("Contact not found")
      }
      if (props.dealId) {
        const [deal] = await tx
          .select({ id: dealModel.id })
          .from(dealModel)
          .where(
            and(
              eq(dealModel.id, props.dealId),
              eq(dealModel.workspaceId, props.workspaceId),
            ),
          )
          .limit(1)
        if (!deal) {
          throw notFoundException("Deal not found")
        }
      }
      const [{ next } = { next: 1 }] = await tx
        .select({
          next: sql<number>`coalesce(max(${invoiceModel.number}), 0)::int + 1`,
        })
        .from(invoiceModel)
        .where(eq(invoiceModel.workspaceId, props.workspaceId))
      const now = new Date()
      const [row] = await tx
        .insert(invoiceModel)
        .values({
          workspaceId: props.workspaceId,
          number: next,
          status: "draft",
          method: "stripeInvoice",
          currency,
          total: minorToDecimalString(totalMinor, currency),
          memo: props.memo || null,
          dueAt: new Date(now.getTime() + props.dueDays * DAY_MS),
          sourceKey: props.sourceKey ?? null,
          requestHash,
          contactId: contact.id,
          companyId: contact.companyId,
          dealId: props.dealId ?? null,
          integrationId: credentials.integrationId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
      if (!row) {
        throw new Error("invoice create: insert returned no row")
      }
      await tx.insert(invoiceLineItemModel).values(
        lines.map((line) => ({
          invoiceId: row.id,
          position: line.position,
          description: line.description,
          quantity: line.quantity,
          unitAmount: line.unitAmount,
          amount: minorToDecimalString(line.amountMinor, currency),
        })),
      )
      return { invoice: row, created: true }
    })

    if (created) {
      await this.audit(
        "create",
        `created invoice #${invoice.number} (${invoice.total} ${invoice.currency})`,
      )
    }
    if (invoice.status === "draft") {
      return await this.finalize({
        workspaceId: invoice.workspaceId,
        id: invoice.id,
      })
    }
    return await this.get({ workspaceId: invoice.workspaceId, id: invoice.id })
  }

  /** Collect a draft through its provider; a non-draft is returned as is. */
  async finalize(ref: InvoiceRef): Promise<InvoiceWithLines> {
    const invoice = await this.get(ref)
    if (invoice.status !== "draft") {
      return invoice
    }
    const credentials =
      await integrationStripeService.credentialsByWorkspaceIdOrFail(
        invoice.workspaceId,
      )
    if (
      (invoice.integrationId &&
        invoice.integrationId !== credentials.integrationId) ||
      (invoice.providerAccountId &&
        invoice.providerAccountId !== credentials.accountId)
    ) {
      throw validationException(
        "invoice",
        "This invoice belongs to a Stripe connection that was replaced",
      )
    }
    let result: Awaited<ReturnType<typeof finalizeWithStripe>>
    try {
      result = await finalizeWithStripe({
        credentials,
        invoice,
        lines: invoice.lineItems,
      })
    } catch (error) {
      const providerError =
        error instanceof InvoiceProviderError
          ? error
          : new InvoiceProviderError(
              error instanceof Error ? error.message : "finalize failed",
              true,
            )
      await db
        .update(invoiceModel)
        .set({ lastError: providerError.message, updatedAt: new Date() })
        .where(
          and(
            eq(invoiceModel.id, invoice.id),
            eq(invoiceModel.status, "draft"),
          ),
        )
      logger.warn(
        { err: error, invoiceId: invoice.id },
        "invoice: finalize failed",
      )
      throw new InvoiceFinalizeError(
        providerError.message,
        providerError.retryable,
        invoice,
      )
    }
    const status = result.status ? FINALIZED_STATUS[result.status] : undefined
    if (!status) {
      throw new InvoiceFinalizeError(
        `Stripe left the invoice in status ${result.status ?? "unknown"}`,
        true,
        invoice,
      )
    }
    const [opened] = await db
      .update(invoiceModel)
      .set({
        status,
        providerInvoiceId: result.providerInvoiceId,
        providerAccountId: credentials.accountId,
        providerCustomerId: result.providerCustomerId,
        integrationId: credentials.integrationId,
        hostedUrl: result.hostedUrl,
        pdfUrl: result.pdfUrl,
        dueAt: result.dueAt ?? invoice.dueAt,
        paidAt: status === "paid" ? new Date() : null,
        voidedAt: status === "void" ? new Date() : null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(eq(invoiceModel.id, invoice.id), eq(invoiceModel.status, "draft")),
      )
      .returning()
    if (!opened) {
      await this.voidAtStripeIfVoidedMeanwhile(invoice, result.status)
    }
    if (opened?.status === "open") {
      try {
        await emitInvoiceCreated(
          opened.workspaceId,
          opened.contactId,
          invoiceEventMetadata(opened),
        )
      } catch (error) {
        logger.warn(
          { err: error, invoiceId: opened.id },
          "invoice: invoiceCreated emit failed",
        )
      }
    }
    return await this.get(ref)
  }

  /**
   * The draft was voided here while this finalize was talking to Stripe (a
   * void of a draft without a Stripe id skips Stripe): the Stripe invoice
   * this finalize just opened must not stay payable under a void hub row.
   */
  private async voidAtStripeIfVoidedMeanwhile(
    invoice: InvoiceModel,
    stripeStatus: string | null,
  ): Promise<void> {
    const [current] = await db
      .select({ status: invoiceModel.status })
      .from(invoiceModel)
      .where(eq(invoiceModel.id, invoice.id))
      .limit(1)
    if (current?.status !== "void" || stripeStatus !== "open") {
      return
    }
    try {
      const credentials =
        await integrationStripeService.credentialsByWorkspaceIdOrFail(
          invoice.workspaceId,
        )
      const [withId] = await db
        .select()
        .from(invoiceModel)
        .where(eq(invoiceModel.id, invoice.id))
        .limit(1)
      if (withId) {
        await voidWithStripe({ credentials, invoice: withId })
      }
    } catch (error) {
      logger.error(
        { err: error, invoiceId: invoice.id },
        "invoice: voided during finalize, but the Stripe invoice could not be voided",
      )
      await db
        .update(invoiceModel)
        .set({
          lastError: "Voided here while Stripe opened it: void it in Stripe",
          updatedAt: new Date(),
        })
        .where(eq(invoiceModel.id, invoice.id))
    }
  }

  /** Void an unpaid invoice here and at the provider. */
  async void(ref: InvoiceRef): Promise<InvoiceWithLines> {
    const invoice = await this.get(ref)
    if (!INVOICE_STATUS_TRANSITIONS.void.includes(invoice.status)) {
      throw validationException(
        "invoice",
        `A ${invoice.status} invoice cannot be voided`,
      )
    }
    if (invoice.providerInvoiceId) {
      const credentials =
        await integrationStripeService.credentialsByWorkspaceIdOrFail(
          invoice.workspaceId,
        )
      try {
        await voidWithStripe({ credentials, invoice })
      } catch (error) {
        throw validationException(
          "invoice",
          error instanceof Error ? error.message : "Could not void at Stripe",
        )
      }
    }
    const voided = await this.transition({
      invoiceId: invoice.id,
      to: "void",
      set: { voidedAt: new Date() },
    })
    if (voided) {
      await this.audit("void", `voided invoice #${invoice.number}`)
    }
    return await this.get(ref)
  }

  /**
   * CAS status change: applies only from an allowed `from` state (a late or
   * out-of-order event is a no-op). Returns the updated row or null.
   */
  async transition(props: {
    invoiceId: string
    to: InvoiceStatus
    set?: Partial<Pick<InvoiceModel, "paidAt" | "voidedAt">>
    tx?: Pick<typeof db, "update">
  }): Promise<InvoiceModel | null> {
    const from = INVOICE_STATUS_TRANSITIONS[props.to]
    if (from.length === 0) {
      return null
    }
    const [row] = await (props.tx ?? db)
      .update(invoiceModel)
      .set({ status: props.to, ...props.set, updatedAt: new Date() })
      .where(
        and(
          eq(invoiceModel.id, props.invoiceId),
          inArray(invoiceModel.status, [...from]),
        ),
      )
      .returning()
    return row ?? null
  }
}

export const invoiceService = new InvoiceService()
