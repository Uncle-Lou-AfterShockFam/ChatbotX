import { createHash } from "node:crypto"
import { and, db, eq, isNull } from "@chatbotx.io/database/client"
import { decimalStringToMinor } from "@chatbotx.io/database/partials"
import {
  contactModel,
  invoiceModel,
  stripeCustomerModel,
} from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import { createStripeClient, Stripe } from "../integration-stripe/client"
import type { StripeCredentials } from "../integration-stripe/service"

/**
 * Stripe caps a single charge at 8 digits of minor units (USD $999,999.99);
 * the hub rejects a larger invoice before calling Stripe.
 */
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n

export class InvoiceProviderError extends Error {
  readonly retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = "InvoiceProviderError"
    this.retryable = retryable
  }
}

export type FinalizedStripeInvoice = {
  providerInvoiceId: string
  providerCustomerId: string
  hostedUrl: string | null
  pdfUrl: string | null
  dueAt: Date | null
  status: Stripe.Invoice.Status | null
}

const stripeErrorText = (error: unknown): string =>
  error instanceof Error ? error.message.slice(0, 300) : "Stripe request failed"

/** Network / rate-limit / 5xx are worth a retry; a 4xx is the caller's input. */
export const isRetryableStripeError = (error: unknown): boolean => {
  if (!(error instanceof Stripe.errors.StripeError)) {
    return false
  }
  return (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    error instanceof Stripe.errors.StripeAPIError ||
    (error.statusCode ?? 0) >= 500
  )
}

const wrap = (error: unknown, step: string): InvoiceProviderError =>
  error instanceof InvoiceProviderError
    ? error
    : new InvoiceProviderError(
        `Stripe ${step}: ${stripeErrorText(error)}`,
        isRetryableStripeError(error),
      )

const paramsHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)

async function ensureCustomer(
  stripe: Stripe,
  credentials: StripeCredentials,
  invoice: InvoiceModel,
): Promise<string> {
  const existing = await db.query.stripeCustomerModel.findFirst({
    where: {
      integrationId: credentials.integrationId,
      contactId: invoice.contactId,
    },
  })
  if (existing) {
    return existing.customerId
  }
  const [contact] = await db
    .select({
      fullName: contactModel.fullName,
      email: contactModel.email,
      phoneNumber: contactModel.phoneNumber,
    })
    .from(contactModel)
    .where(
      and(
        eq(contactModel.id, invoice.contactId),
        eq(contactModel.workspaceId, invoice.workspaceId),
      ),
    )
    .limit(1)
  if (!contact) {
    throw new InvoiceProviderError("Contact not found", false)
  }
  const params: Stripe.CustomerCreateParams = {
    ...(contact.fullName ? { name: contact.fullName.slice(0, 256) } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phoneNumber ? { phone: contact.phoneNumber } : {}),
    metadata: {
      hub_contact_id: invoice.contactId,
      hub_workspace_id: invoice.workspaceId,
    },
  }
  let customer: Stripe.Customer
  try {
    // The params hash keeps a same-key replay valid when the contact's name
    // changed inside Stripe's 24 h idempotency window.
    customer = await stripe.customers.create(params, {
      idempotencyKey: `hub-cust-${credentials.integrationId}-${invoice.contactId}-${paramsHash(params)}`,
    })
  } catch (error) {
    throw wrap(error, "customer")
  }
  await db
    .insert(stripeCustomerModel)
    .values({
      workspaceId: invoice.workspaceId,
      integrationId: credentials.integrationId,
      contactId: invoice.contactId,
      customerId: customer.id,
    })
    .onConflictDoNothing()
  const stored = await db.query.stripeCustomerModel.findFirst({
    where: {
      integrationId: credentials.integrationId,
      contactId: invoice.contactId,
    },
  })
  return stored?.customerId ?? customer.id
}

/**
 * Create (or resume) the Stripe invoice behind a hub draft. Every mutating
 * call carries a deterministic Idempotency-Key and every step is re-entrant:
 * the Stripe invoice id is persisted the moment it exists, line items already
 * on it (metadata `hub_line_position`) are skipped, and an already-finalized
 * invoice is not finalized again. The finalized total must equal the hub
 * total to the minor unit, else the Stripe invoice is voided and this throws.
 */
export async function finalizeWithStripe(props: {
  credentials: StripeCredentials
  invoice: InvoiceModel
  lines: InvoiceLineItemModel[]
}): Promise<FinalizedStripeInvoice> {
  const { credentials, invoice, lines } = props
  const currency = invoice.currency.toLowerCase()
  const totalMinor = decimalStringToMinor(invoice.total, invoice.currency)
  if (totalMinor <= 0n || totalMinor > STRIPE_MAX_AMOUNT_MINOR) {
    throw new InvoiceProviderError(
      "Invoice total is outside what Stripe accepts",
      false,
    )
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  const customerId = await ensureCustomer(stripe, credentials, invoice)

  let stripeInvoiceId = invoice.providerInvoiceId
  if (!stripeInvoiceId) {
    let created: Stripe.Invoice
    try {
      created = await stripe.invoices.create(
        {
          customer: customerId,
          currency,
          collection_method: "send_invoice",
          days_until_due: Math.max(
            1,
            invoice.dueAt
              ? Math.ceil(
                  (invoice.dueAt.getTime() - invoice.createdAt.getTime()) /
                    86_400_000,
                )
              : 1,
          ),
          auto_advance: false,
          pending_invoice_items_behavior: "exclude",
          ...(invoice.memo ? { description: invoice.memo } : {}),
          metadata: {
            hub_invoice_id: invoice.id,
            hub_workspace_id: invoice.workspaceId,
            hub_invoice_number: String(invoice.number),
          },
        },
        { idempotencyKey: `hub-inv-${invoice.id}-create` },
      )
    } catch (error) {
      throw wrap(error, "create invoice")
    }
    if (!created.id) {
      throw new InvoiceProviderError("Stripe returned no invoice id", true)
    }
    stripeInvoiceId = created.id
    // Persist the id NOW so a crash below resumes this invoice, never a twin.
    await db
      .update(invoiceModel)
      .set({
        providerInvoiceId: stripeInvoiceId,
        providerCustomerId: customerId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoiceModel.id, invoice.id),
          isNull(invoiceModel.providerInvoiceId),
        ),
      )
  }

  let current: Stripe.Invoice
  try {
    current = await stripe.invoices.retrieve(stripeInvoiceId)
  } catch (error) {
    throw wrap(error, "retrieve invoice")
  }

  if (current.status === "draft") {
    const present = new Set<string>()
    try {
      for await (const line of stripe.invoices.listLineItems(stripeInvoiceId, {
        limit: 100,
      })) {
        const position = line.metadata?.hub_line_position
        if (position) {
          present.add(position)
        }
      }
    } catch (error) {
      throw wrap(error, "list line items")
    }
    for (const line of lines) {
      const position = String(line.position)
      if (present.has(position)) {
        continue
      }
      try {
        await stripe.invoiceItems.create(
          {
            customer: customerId,
            invoice: stripeInvoiceId,
            currency,
            description: line.description,
            quantity: line.quantity,
            unit_amount_decimal: Stripe.Decimal.from(
              decimalStringToMinor(line.unitAmount, invoice.currency),
            ),
            metadata: { hub_line_position: position },
          },
          { idempotencyKey: `hub-inv-${invoice.id}-line-${position}` },
        )
      } catch (error) {
        throw wrap(error, "add line item")
      }
    }
    try {
      current = await stripe.invoices.finalizeInvoice(
        stripeInvoiceId,
        { auto_advance: false },
        { idempotencyKey: `hub-inv-${invoice.id}-finalize` },
      )
    } catch (error) {
      throw wrap(error, "finalize invoice")
    }
  }

  if (
    BigInt(current.total) !== totalMinor ||
    current.currency.toLowerCase() !== currency
  ) {
    if (current.status === "open") {
      await stripe.invoices
        .voidInvoice(stripeInvoiceId, undefined, {
          idempotencyKey: `hub-inv-${invoice.id}-void-mismatch`,
        })
        .catch(() => undefined)
    }
    throw new InvoiceProviderError(
      `Stripe total ${current.total} ${current.currency} does not match the hub total ${totalMinor} ${currency}; the Stripe invoice was voided`,
      false,
    )
  }

  return {
    providerInvoiceId: stripeInvoiceId,
    providerCustomerId: customerId,
    hostedUrl: current.hosted_invoice_url ?? null,
    pdfUrl: current.invoice_pdf ?? null,
    dueAt: current.due_date ? new Date(current.due_date * 1000) : null,
    status: current.status,
  }
}

/** Void the Stripe side of an invoice (a Stripe draft is deleted instead). */
export async function voidWithStripe(props: {
  credentials: StripeCredentials
  invoice: InvoiceModel
}): Promise<void> {
  const { credentials, invoice } = props
  if (!invoice.providerInvoiceId) {
    return
  }
  const stripe = createStripeClient(credentials.auth.secretKey)
  try {
    const current = await stripe.invoices.retrieve(invoice.providerInvoiceId)
    if (current.status === "draft") {
      await stripe.invoices.del(invoice.providerInvoiceId)
    } else if (
      current.status === "open" ||
      current.status === "uncollectible"
    ) {
      await stripe.invoices.voidInvoice(invoice.providerInvoiceId, undefined, {
        idempotencyKey: `hub-inv-${invoice.id}-void`,
      })
    } else if (current.status === "paid") {
      throw new InvoiceProviderError("A paid invoice cannot be voided", false)
    }
  } catch (error) {
    throw wrap(error, "void invoice")
  }
}
