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
  depositInvoiceMethods,
  INVOICE_STATUS_TRANSITIONS,
  type InvoiceDepositType,
  type InvoiceStatus,
  minorToDecimalString,
  normalizeInvoiceCurrency,
  parseMoneyToMinor,
  type RequestedInvoiceMethod,
  resolveDepositMinor,
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
import { logger } from "../logger"
import { markInvoiceCreated } from "./contact-marks"
import { enqueueInvoiceMirror } from "./mirror"
import {
  bindNewInvoice,
  InvoiceFinalizeError,
  invoiceProviders,
} from "./providers"
import {
  type CreateInvoiceInput,
  createInvoiceInputSchema,
  type InvoiceRef,
  invoiceRefSchema,
  type ListInvoicesInput,
  listInvoicesInputSchema,
} from "./schema"
import {
  InvoiceProviderError,
  STRIPE_MAX_AMOUNT_MINOR,
} from "./stripe-provider"

export { InvoiceFinalizeError } from "./providers"

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
  method?: RequestedInvoiceMethod
  integrationId?: string
  deposit?: { type: InvoiceDepositType; amount: string }
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
        // Only an explicit method joins the hash: a pre-s207b replay (no
        // method) still matches, and a later change of the workspace default
        // never turns a replay into a conflict.
        ...(request.method && request.method !== "default"
          ? [request.method]
          : []),
        // Only a named site joins it, for the same reason (s211b).
        ...(request.integrationId ? [request.integrationId] : []),
        // Only a deposit joins it (s216b): the RESOLVED amount, so "25%" and
        // "50.00" on a 200.00 invoice are the same request.
        ...(request.deposit ? [["deposit", request.deposit.amount]] : []),
      ]),
    )
    .digest("hex")

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
   * Create a hub invoice and collect it through its method's provider.
   * Idempotent on `sourceKey`: a replay returns the first invoice (resuming
   * its finalize when it is still a draft) and never creates a second one.
   */
  async create(
    input: CreateInvoiceInput,
    options: { contactInboxId?: string } = {},
  ): Promise<InvoiceWithLines> {
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
    const binding = await bindNewInvoice(props.method, {
      workspaceId: props.workspaceId,
      integrationId: props.integrationId,
      currency,
    })
    let deposit:
      | { type: InvoiceDepositType; value: string; amount: string }
      | undefined
    if (props.deposit) {
      if (!depositInvoiceMethods.includes(binding.method)) {
        throw validationException(
          "deposit",
          "Deposits need the stripeCheckout method",
        )
      }
      const depositMinor = resolveDepositMinor({
        type: props.deposit.type,
        value: props.deposit.value,
        totalMinor,
        currency,
      })
      if (depositMinor === null) {
        throw validationException(
          "deposit",
          props.deposit.type === "percent"
            ? "The deposit must be a percent above 0 and below 100"
            : `The deposit must be a ${currency} amount above zero and below the total`,
        )
      }
      deposit = {
        type: props.deposit.type,
        value: String(props.deposit.value).trim(),
        amount: minorToDecimalString(depositMinor, currency),
      }
    }
    const requestHash = invoiceRequestHash({
      ...props,
      currency,
      lines,
      deposit,
    })

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
              // Only the SAME content is a duplicate; a different order
              // through the same step inside the window is a new invoice.
              eq(invoiceModel.requestHash, requestHash),
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
          method: binding.method,
          currency,
          total: minorToDecimalString(totalMinor, currency),
          depositType: deposit?.type ?? null,
          depositValue: deposit?.value ?? null,
          depositAmount: deposit?.amount ?? null,
          memo: props.memo || null,
          dueAt: new Date(now.getTime() + props.dueDays * DAY_MS),
          sourceKey: props.sourceKey ?? null,
          requestHash,
          contactId: contact.id,
          companyId: contact.companyId,
          dealId: props.dealId ?? null,
          integrationId: binding.integrationId,
          providerAccountId: binding.providerAccountId ?? null,
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
      return await this.finalize(
        { workspaceId: invoice.workspaceId, id: invoice.id },
        options,
      )
    }
    return await this.get({ workspaceId: invoice.workspaceId, id: invoice.id })
  }

  /**
   * Collect a draft through its provider; a non-draft is returned as is.
   * `contactInboxId` (the flow step's) rides the contact marks' change events.
   */
  async finalize(
    ref: InvoiceRef,
    options: { contactInboxId?: string } = {},
  ): Promise<InvoiceWithLines> {
    const invoice = await this.get(ref)
    if (invoice.status !== "draft") {
      return invoice
    }
    const connection = await invoiceProviders[invoice.method].connect(invoice)
    let result: Awaited<ReturnType<typeof connection.open>>
    try {
      result = await connection.open()
    } catch (error) {
      if (error instanceof InvoiceFinalizeError) {
        throw error
      }
      throw await this.recordFinalizeFailure(invoice, error)
    }
    const [opened] = await db
      .update(invoiceModel)
      .set({ ...result.set, lastError: null, updatedAt: new Date() })
      .where(
        and(eq(invoiceModel.id, invoice.id), eq(invoiceModel.status, "draft")),
      )
      .returning()
    if (opened) {
      await result.afterOpen?.()
    } else {
      await result.onDraftLost?.()
    }
    if (opened?.status === "open" || opened?.status === "paid") {
      // Marks first: an invoiceCreated flow reads invoice_last_id.
      await this.markCreated(opened, options.contactInboxId)
    }
    if (opened?.status === "open") {
      await this.emitCreated(opened)
    }
    if (opened) {
      await enqueueInvoiceMirror(opened)
    }
    return await this.get(ref)
  }

  /**
   * Best effort: the invoice is already open, so a failed contact write must
   * not turn the create into an error a caller would retry. The flow step
   * re-marks strictly on its own.
   */
  private async markCreated(
    opened: InvoiceModel,
    contactInboxId: string | undefined,
  ): Promise<void> {
    try {
      await markInvoiceCreated({ invoice: opened, contactInboxId })
    } catch (error) {
      logger.warn(
        { err: error, invoiceId: opened.id },
        "invoice: contact marks at open failed",
      )
    }
  }

  private async emitCreated(opened: InvoiceModel): Promise<void> {
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

  /** Keep the draft retryable with its `lastError`; return the error to throw. */
  private async recordFinalizeFailure(
    invoice: InvoiceModel,
    error: unknown,
  ): Promise<InvoiceFinalizeError> {
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
        and(eq(invoiceModel.id, invoice.id), eq(invoiceModel.status, "draft")),
      )
    logger.warn(
      { err: error, invoiceId: invoice.id },
      "invoice: finalize failed",
    )
    return new InvoiceFinalizeError(
      providerError.message,
      providerError.retryable,
      invoice,
    )
  }

  /** Void an unpaid invoice here and at the provider. */
  async void(ref: InvoiceRef): Promise<InvoiceWithLines> {
    const invoice = await this.get(ref)
    if (invoice.status === "partiallyPaid") {
      throw validationException(
        "invoice",
        "A deposit was paid on this invoice: refund it in Stripe, it cannot be voided",
      )
    }
    if (!INVOICE_STATUS_TRANSITIONS.void.includes(invoice.status)) {
      throw validationException(
        "invoice",
        `A ${invoice.status} invoice cannot be voided`,
      )
    }
    const { afterVoid } =
      await invoiceProviders[invoice.method].prepareVoid(invoice)
    const voided = await this.transition({
      invoiceId: invoice.id,
      to: "void",
      set: { voidedAt: new Date() },
    })
    if (voided) {
      await this.audit("void", `voided invoice #${invoice.number}`)
      await afterVoid?.(voided)
      await enqueueInvoiceMirror(voided)
    } else {
      const current = await this.get(ref)
      if (current.status === "partiallyPaid") {
        // A deposit landed while this void was in flight (s216b probe H5).
        throw validationException(
          "invoice",
          "A deposit was paid on this invoice while it was being voided: refund it in Stripe, it cannot be voided",
        )
      }
      return current
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
    set?: Partial<
      Pick<InvoiceModel, "paidAt" | "voidedAt" | "providerInvoiceId">
    >
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
