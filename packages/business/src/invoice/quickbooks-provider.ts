import { and, db, eq, isNull } from "@chatbotx.io/database/client"
import { invoiceModel } from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { validationException } from "../errors"
import {
  assertQuickbooksCurrency,
  ensureQuickbooksCustomer,
  QuickbooksBooksError,
  upsertQuickbooksInvoice,
} from "../integration-quickbooks/books"
import {
  QuickbooksApiError,
  QuickbooksReconnectRequiredError,
} from "../integration-quickbooks/client"
import {
  type QuickbooksConnection,
  quickbooksCall,
  quickbooksConnectionOf,
} from "../integration-quickbooks/connection"
import {
  getQuickbooksInvoice,
  isQuickbooksInvoicePaid,
  type QuickbooksCall,
  type QuickbooksInvoice,
  voidQuickbooksInvoice,
} from "../integration-quickbooks/entities"
import { logger } from "../logger"
import { resolveWorkspaceAppUrl } from "../platform/settings"
import { invoicePayUrl, mintInvoicePayToken } from "./checkout-provider"
import type { InvoiceProvider } from "./providers"
import { InvoiceProviderError } from "./stripe-provider"

const QBO_ID = /^\d{1,20}$/

/**
 * `Invoice.providerInvoiceId` of a QBO invoice: `qbo:<realmId>:<Id>`, unique
 * across companies (QBO ids are per company).
 */
export const quickbooksProviderInvoiceId = (realmId: string, id: string) =>
  `qbo:${realmId}:${id}`

/** The QBO invoice id of a `qbo:` provider id of `realmId`, or null. */
export const quickbooksInvoiceIdOf = (
  providerInvoiceId: string | null,
  realmId?: string,
): string | null => {
  const [kind, realm, id] = providerInvoiceId?.split(":") ?? []
  return kind === "qbo" &&
    realm &&
    id &&
    QBO_ID.test(id) &&
    (realmId === undefined || realm === realmId)
    ? id
    : null
}

export const quickbooksCallFor =
  (integrationId: string): QuickbooksCall =>
  (request) =>
    quickbooksCall(integrationId, request)

/**
 * The workspace's QBO company when it is the one the invoice names (the
 * integration AND the realm), else null (disconnected or replaced).
 */
async function connectionFor(
  invoice: InvoiceModel,
): Promise<QuickbooksConnection | null> {
  const connection = await quickbooksConnectionOf(invoice.workspaceId)
  if (
    !connection ||
    (invoice.integrationId &&
      invoice.integrationId !== connection.integrationId) ||
    (invoice.providerAccountId &&
      invoice.providerAccountId !== connection.realmId)
  ) {
    return null
  }
  return connection
}

/** A QBO failure as the service's provider error (retryable or not). */
export function toQuickbooksProviderError(
  error: unknown,
): InvoiceProviderError {
  if (error instanceof InvoiceProviderError) {
    return error
  }
  if (error instanceof QuickbooksApiError) {
    return new InvoiceProviderError(
      error.message.slice(0, 500),
      error.retryable,
    )
  }
  if (
    error instanceof QuickbooksBooksError ||
    error instanceof QuickbooksReconnectRequiredError
  ) {
    return new InvoiceProviderError(error.message, false)
  }
  return new InvoiceProviderError(
    error instanceof Error ? error.message.slice(0, 500) : "QuickBooks failed",
    true,
  )
}

/** QBO shows a payment on it: a paid or part-paid invoice is never voided. */
const hasPayment = (invoice: QuickbooksInvoice): boolean =>
  invoice.balance !== null &&
  invoice.totalAmt !== null &&
  invoice.balance < invoice.totalAmt

async function recordLastErrorIfClear(invoiceId: string, message: string) {
  await db
    .update(invoiceModel)
    .set({ lastError: message.slice(0, 1000), updatedAt: new Date() })
    .where(and(eq(invoiceModel.id, invoiceId), isNull(invoiceModel.lastError)))
}

/** Best effort: void a QBO invoice the hub no longer collects, else say so. */
async function voidAtQuickbooks(props: {
  invoiceId: string
  integrationId: string
  qboId: string
  why: string
}): Promise<void> {
  try {
    await voidQuickbooksInvoice(
      quickbooksCallFor(props.integrationId),
      props.qboId,
    )
  } catch (error) {
    logger.warn(
      { err: error, invoiceId: props.invoiceId, qboId: props.qboId },
      "invoice: the QuickBooks invoice could not be voided",
    )
    await recordLastErrorIfClear(
      props.invoiceId,
      `${props.why}, but QuickBooks invoice ${props.qboId} was not voided (${error instanceof Error ? error.message.slice(0, 300) : "failed"}): void it in QuickBooks`,
    )
  }
}

/**
 * quickbooks (s214b): the workspace's QBO company holds the invoice and
 * QuickBooks Payments takes the money; the InvoiceLink is the pay link. QBO
 * produces that link only for a customer with an email in a company with
 * online payments on, so a contact without an email is refused, and an
 * invoice QBO gave no link is voided there and refused (never a linkless
 * open invoice). The hub's own PDF rides `/pay/<token>/pdf`. A payment in
 * QBO reaches the hub by webhook (or the CDC backstop poll).
 *
 * A void reads the QBO invoice first: one that shows a payment refuses the
 * void (refund it in QuickBooks); otherwise the hub voids and then QBO does,
 * and a QBO failure leaves `lastError` naming the invoice to void by hand.
 */
export const quickbooksInvoiceProvider: InvoiceProvider = {
  async bind({ workspaceId, integrationId, currency }) {
    if (integrationId) {
      throw validationException(
        "integrationId",
        "integrationId names a WooCommerce site: use it with method woocommerce",
      )
    }
    const connection = await quickbooksConnectionOf(workspaceId)
    if (!connection) {
      throw validationException("method", "QuickBooks is not connected")
    }
    if (connection.tokenRefreshError) {
      throw validationException("method", "QuickBooks needs to be reconnected")
    }
    try {
      assertQuickbooksCurrency(connection, currency)
    } catch (error) {
      throw validationException(
        "currency",
        error instanceof Error ? error.message : "Unsupported currency",
      )
    }
    return {
      integrationId: connection.integrationId,
      providerAccountId: connection.realmId,
    }
  },
  async connect(invoice) {
    const connection = await connectionFor(invoice)
    if (!connection) {
      throw validationException(
        "invoice",
        "This invoice's QuickBooks company is no longer connected",
      )
    }
    const call = quickbooksCallFor(connection.integrationId)
    return {
      async open() {
        // Everything that can fail runs before the QBO invoice exists.
        const payToken = mintInvoicePayToken()
        const appUrl = await resolveWorkspaceAppUrl({
          workspaceId: invoice.workspaceId,
        })
        let qbo: QuickbooksInvoice
        let customerId: string
        try {
          assertQuickbooksCurrency(connection, invoice.currency)
          const customer = await ensureQuickbooksCustomer({
            call,
            connection,
            invoice,
          })
          customerId = customer.customerId
          if (!customer.email) {
            throw new QuickbooksBooksError(
              "QuickBooks pay links need the contact's email address",
            )
          }
          const result = await upsertQuickbooksInvoice({
            call,
            connection,
            invoice,
            lines: invoice.lineItems,
            customerId,
            collect: { email: customer.email },
            // A new request id per recorded failure (finalize writes
            // lastError, which moves updatedAt): never stuck on a cached error.
            attemptKey: invoice.updatedAt.getTime().toString(36),
          })
          qbo = result.qbo
          if (!result.totalMatches) {
            await voidAtQuickbooks({
              invoiceId: invoice.id,
              integrationId: connection.integrationId,
              qboId: qbo.id,
              why: "Refused (total mismatch)",
            })
            throw new QuickbooksBooksError(
              `QuickBooks totals this invoice at ${qbo.totalAmt ?? "?"} ${invoice.currency}, not ${invoice.total} (sales tax on the "Hub sales" item?)`,
            )
          }
          if (!(qbo.invoiceLink || isQuickbooksInvoicePaid(qbo))) {
            qbo = (await getQuickbooksInvoice(call, qbo.id)) ?? qbo
          }
          if (!(qbo.invoiceLink || isQuickbooksInvoicePaid(qbo))) {
            await voidAtQuickbooks({
              invoiceId: invoice.id,
              integrationId: connection.integrationId,
              qboId: qbo.id,
              why: "Refused (no pay link)",
            })
            throw new QuickbooksBooksError(
              "QuickBooks gave no online pay link: turn on QuickBooks Payments (cards) for this company",
            )
          }
        } catch (error) {
          throw toQuickbooksProviderError(error)
        }
        const paid = isQuickbooksInvoicePaid(qbo)
        const providerInvoiceId = quickbooksProviderInvoiceId(
          connection.realmId,
          qbo.id,
        )
        const qboId = qbo.id
        return {
          set: {
            status: paid ? "paid" : "open",
            providerInvoiceId,
            providerAccountId: connection.realmId,
            providerCustomerId: customerId,
            integrationId: connection.integrationId,
            hostedUrl: qbo.invoiceLink,
            payToken,
            pdfUrl: `${invoicePayUrl(appUrl, payToken)}/pdf`,
            paidAt: paid ? new Date() : null,
          },
          // The draft CAS missed: only a VOID row naming no QBO invoice yet is
          // ours to claim (a concurrent finalize that won keeps its invoice).
          onDraftLost: async () => {
            const [claimed] = await db
              .update(invoiceModel)
              .set({ providerInvoiceId, updatedAt: new Date() })
              .where(
                and(
                  eq(invoiceModel.id, invoice.id),
                  eq(invoiceModel.status, "void"),
                  isNull(invoiceModel.providerInvoiceId),
                ),
              )
              .returning({ id: invoiceModel.id })
            if (claimed) {
              await voidAtQuickbooks({
                invoiceId: invoice.id,
                integrationId: connection.integrationId,
                qboId,
                why: "Voided here while QuickBooks opened it",
              })
            }
          },
        }
      },
    }
  },
  async prepareVoid(invoice) {
    const qboId = quickbooksInvoiceIdOf(invoice.providerInvoiceId)
    const connection = qboId ? await connectionFor(invoice) : null
    if (qboId && connection) {
      let current: QuickbooksInvoice | null = null
      try {
        current = await getQuickbooksInvoice(
          quickbooksCallFor(connection.integrationId),
          qboId,
        )
      } catch (error) {
        // Only a QBO answer that shows a payment refuses; unreachable voids.
        logger.warn(
          { err: error, invoiceId: invoice.id, qboId },
          "invoice: QuickBooks unreachable before a void",
        )
      }
      if (current && hasPayment(current)) {
        throw validationException(
          "invoice",
          `QuickBooks invoice ${qboId} already has a payment: refund it in QuickBooks`,
        )
      }
    }
    return {
      async afterVoid(voided) {
        // The voided row may name an invoice the snapshot did not (a
        // finalize opened it meanwhile): void whatever the row names now.
        const voidedId = quickbooksInvoiceIdOf(voided.providerInvoiceId)
        if (!voidedId) {
          return
        }
        const current = await connectionFor(voided)
        if (!current) {
          await recordLastErrorIfClear(
            voided.id,
            `Voided here, but QuickBooks is no longer connected: void invoice ${voidedId} in QuickBooks`,
          )
          return
        }
        await voidAtQuickbooks({
          invoiceId: voided.id,
          integrationId: current.integrationId,
          qboId: voidedId,
          why: "Voided here",
        })
      },
    }
  },
}
