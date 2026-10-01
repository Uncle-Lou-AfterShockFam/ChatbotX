import { and, db, eq, isNull } from "@chatbotx.io/database/client"
import type {
  InvoiceMethod,
  InvoiceStatus,
  RequestedInvoiceMethod,
} from "@chatbotx.io/database/partials"
import { invoiceModel } from "@chatbotx.io/database/schema"
import type {
  InvoiceLineItemModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import { ChatbotXException, validationException } from "../errors"
import {
  integrationStripeService,
  type StripeCredentials,
} from "../integration-stripe/service"
import {
  integrationWooCommerceService,
  type WooCommerceCredentials,
} from "../integration-woocommerce/service"
import { logger } from "../logger"
import { resolveWorkspaceAppUrl } from "../platform/settings"
import {
  assertCheckoutNotPaid,
  expireCheckoutAfterVoid,
  invoicePayUrl,
  mintInvoicePayToken,
  prepareCheckoutInvoice,
} from "./checkout-provider"
import { appendLastError, recordLastErrorIfClear } from "./last-error"
import { quickbooksInvoiceProvider } from "./quickbooks-provider"
import { finalizeWithStripe, voidWithStripe } from "./stripe-provider"
import {
  cancelWooCommerceOrder,
  createWooCommerceOrder,
  type WooCommerceCancelOutcome,
  wooCommerceOrderIdOf,
  wooCommerceProviderInvoiceId,
} from "./woocommerce-provider"

type InvoiceWithLines = InvoiceModel & { lineItems: InvoiceLineItemModel[] }

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

/** What the draft -> opened CAS writes, and what runs when that CAS loses. */
export type OpenedInvoice = {
  set: Partial<Omit<InvoiceModel, "id" | "workspaceId" | "number">> & {
    status: InvoiceStatus
  }
  /** The draft left `draft` (a void) while the provider was opening it. */
  onDraftLost?: () => Promise<void>
  /** Runs once the draft -> opened CAS applied (never throws). */
  afterOpen?: () => Promise<void>
}

/**
 * One collection method (s211b PR 1). The service owns the invoice row (the
 * advisory lock, the draft CAS, audit, events); a provider owns only its
 * connection and the calls to the outside system.
 */
export type InvoiceProvider = {
  /**
   * The connection a NEW invoice of this method binds to; throws when none.
   * `providerAccountId` (WooCommerce: the site origin) is stored at create.
   */
  bind(
    props: BindProps,
  ): Promise<{ integrationId: string; providerAccountId?: string }>
  /**
   * The connection an existing draft is opened through. Throws (and the
   * draft keeps no `lastError`) when it is gone or was replaced.
   */
  connect(invoice: InvoiceWithLines): Promise<{
    /** Any throw but InvoiceFinalizeError is recorded as the draft's lastError. */
    open(): Promise<OpenedInvoice>
  }>
  /** Checks before the hub void; `afterVoid` runs once the void applied. */
  prepareVoid(
    invoice: InvoiceModel,
  ): Promise<{ afterVoid?: (voided: InvoiceModel) => Promise<void> }>
}

export type BindProps = {
  workspaceId: string
  /** The connection the caller named (a WooCommerce site), if any. */
  integrationId?: string
  /** The invoice currency, already normalised. */
  currency: string
}

/** Stripe status after finalize -> hub status; anything else is an error. */
const FINALIZED_STATUS: Partial<Record<string, InvoiceStatus>> = {
  open: "open",
  paid: "paid",
  void: "void",
  uncollectible: "uncollectible",
}

async function recordLastError(invoiceId: string, message: string) {
  await db
    .update(invoiceModel)
    .set({ lastError: appendLastError(message), updatedAt: new Date() })
    .where(eq(invoiceModel.id, invoiceId))
}

/** The workspace's Stripe, refused when it is not the one the invoice names. */
async function stripeCredentialsFor(
  invoice: InvoiceModel,
): Promise<StripeCredentials> {
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
  return credentials
}

const bindStripe = async ({ workspaceId, integrationId: named }: BindProps) => {
  if (named) {
    throw validationException(
      "integrationId",
      "integrationId names a WooCommerce site: use it with method woocommerce",
    )
  }
  const { integrationId } =
    await integrationStripeService.credentialsByWorkspaceIdOrFail(workspaceId)
  return { integrationId }
}

/**
 * The draft was voided here while this finalize was talking to Stripe (a
 * void of a draft without a Stripe id skips Stripe): the Stripe invoice
 * this finalize just opened must not stay payable under a void hub row.
 */
async function voidAtStripeIfVoidedMeanwhile(
  invoice: InvoiceModel,
  stripe: { providerInvoiceId: string; status: string | null },
): Promise<void> {
  const [current] = await db
    .select({ status: invoiceModel.status })
    .from(invoiceModel)
    .where(eq(invoiceModel.id, invoice.id))
    .limit(1)
  if (current?.status !== "void" || stripe.status !== "open") {
    return
  }
  try {
    const credentials =
      await integrationStripeService.credentialsByWorkspaceIdOrFail(
        invoice.workspaceId,
      )
    // The id Stripe just returned, never a re-read: the row may not carry it.
    await voidWithStripe({
      credentials,
      invoice: { ...invoice, providerInvoiceId: stripe.providerInvoiceId },
    })
  } catch (error) {
    logger.error(
      { err: error, invoiceId: invoice.id, stripe: stripe.providerInvoiceId },
      "invoice: voided during finalize, but the Stripe invoice could not be voided",
    )
    await db
      .update(invoiceModel)
      .set({
        providerInvoiceId: stripe.providerInvoiceId,
        lastError: `Voided here while Stripe opened ${stripe.providerInvoiceId}: void it in Stripe`,
        updatedAt: new Date(),
      })
      .where(eq(invoiceModel.id, invoice.id))
  }
}

const stripeInvoiceProvider: InvoiceProvider = {
  bind: bindStripe,
  async connect(invoice) {
    const credentials = await stripeCredentialsFor(invoice)
    return {
      async open() {
        const result = await finalizeWithStripe({
          credentials,
          invoice,
          lines: invoice.lineItems,
        })
        const status = result.status
          ? FINALIZED_STATUS[result.status]
          : undefined
        if (!status) {
          throw new InvoiceFinalizeError(
            `Stripe left the invoice in status ${result.status ?? "unknown"}`,
            true,
            invoice,
          )
        }
        return {
          set: {
            status,
            providerInvoiceId: result.providerInvoiceId,
            providerAccountId: credentials.accountId,
            providerCustomerId: result.providerCustomerId,
            integrationId: credentials.integrationId,
            hostedUrl: result.hostedUrl,
            pdfUrl: result.pdfUrl,
            // Auto-charge (no-email customer): Stripe has no due date and
            // enforces none, so the hub shows none either (owner s212b).
            dueAt:
              result.collectionMethod === "charge_automatically"
                ? null
                : (result.dueAt ?? invoice.dueAt),
            paidAt: status === "paid" ? new Date() : null,
            voidedAt: status === "void" ? new Date() : null,
          },
          onDraftLost: () => voidAtStripeIfVoidedMeanwhile(invoice, result),
        }
      },
    }
  },
  async prepareVoid(invoice) {
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
    return {}
  },
}

/**
 * stripeCheckout: opening creates no Stripe object yet, only the customer
 * and the stable pay link; the first `/pay` visit mints a session.
 *
 * A checkout invoice is voided HERE first (a `/pay` visit then cannot record
 * a new session), then the session the void row names is expired. Refused
 * when the recorded session already holds a payment. Without the Stripe
 * connection that minted the session (disconnected, or another account now),
 * the void still happens and `lastError` says which session to expire by
 * hand: refusing forever would help no one.
 */
const stripeCheckoutProvider: InvoiceProvider = {
  bind: bindStripe,
  async connect(invoice) {
    const credentials = await stripeCredentialsFor(invoice)
    return {
      async open() {
        const prepared = await prepareCheckoutInvoice({ credentials, invoice })
        return {
          set: {
            status: "open",
            providerAccountId: credentials.accountId,
            providerCustomerId: prepared.providerCustomerId,
            integrationId: credentials.integrationId,
            payToken: prepared.payToken,
            hostedUrl: prepared.hostedUrl,
          },
        }
      },
    }
  },
  async prepareVoid(invoice) {
    const current =
      invoice.status === "draft"
        ? null
        : await integrationStripeService.credentialsByWorkspaceId(
            invoice.workspaceId,
          )
    const credentials =
      current &&
      current.integrationId === invoice.integrationId &&
      current.accountId === invoice.providerAccountId
        ? current
        : null
    if (credentials) {
      try {
        await assertCheckoutNotPaid({ credentials, invoice })
      } catch (error) {
        throw validationException(
          "invoice",
          error instanceof Error ? error.message : "Could not reach Stripe",
        )
      }
    }
    return {
      async afterVoid(voided) {
        if (!voided.checkoutSessionId) {
          return
        }
        const expireByHand = `Voided here, but checkout session ${voided.checkoutSessionId} (Stripe account ${voided.providerAccountId ?? "unknown"}) could not be expired: expire it in Stripe`
        if (!credentials) {
          await recordLastError(voided.id, expireByHand)
          return
        }
        await expireCheckoutAfterVoid({ credentials, invoice: voided }).catch(
          async (error: unknown) => {
            logger.error(
              { err: error, invoiceId: voided.id },
              "invoice: voided, but its checkout session could not be expired",
            )
            await recordLastError(voided.id, expireByHand)
          },
        )
      },
    }
  },
}

/**
 * The site an existing woocommerce invoice was opened through, or null when
 * it is gone, another workspace's, or its origin changed since.
 */
async function wooCommerceSiteOf(
  invoice: InvoiceModel,
): Promise<WooCommerceCredentials | null> {
  const credentials = invoice.integrationId
    ? await integrationWooCommerceService.credentialsByIntegrationId(
        invoice.integrationId,
      )
    : null
  if (
    !credentials ||
    credentials.workspaceId !== invoice.workspaceId ||
    (invoice.providerAccountId &&
      invoice.providerAccountId !== credentials.siteUrl)
  ) {
    return null
  }
  return credentials
}

/** Cancel `orderId` of `invoice` on its site; a site that is gone is a `failed`. */
async function cancelOnSite(
  invoice: InvoiceModel,
  orderId: string,
): Promise<{ outcome: WooCommerceCancelOutcome; siteSlug: string }> {
  const credentials = await wooCommerceSiteOf(invoice)
  if (!credentials) {
    return {
      outcome: { kind: "failed", reason: "the site is no longer connected" },
      siteSlug: "the site",
    }
  }
  return {
    outcome: await cancelWooCommerceOrder({ credentials, invoice, orderId }),
    siteSlug: credentials.siteSlug,
  }
}

/**
 * woocommerce (s211b): the invoice's site (`Invoice.integrationId`) creates a
 * pending order through hub-connector `order.invoice`; the order-pay page is
 * the link and the site posts `order.paid` to the hub webhook. The hub's own
 * PDF (s213b) rides the invoice's `/pay/<token>/pdf` (an invoice while open,
 * a receipt once paid); `/pay/<token>` itself stays checkout-only.
 *
 * A void asks the site to cancel the order FIRST (hub-connector 0.7.0
 * `order.cancel`, owner s213b): a site that says it is paid refuses the void
 * (refund it in WooCommerce); any other failure (site down, an older plugin,
 * a revoked token) still voids here and `lastError` names the order to cancel
 * there. A later payment of a voided invoice is flagged, never applied.
 *
 * Races (s213b codex probe): a void that read the invoice as a draft while a
 * finalize opened it cancels the order the VOIDED row names, after the void;
 * a finalize that loses its CAS cancels only when its own write claims the
 * void row (a concurrent finalize that won keeps its live order). Residuals:
 * an open whose answer was lost leaves an order the hub never recorded (its
 * payment is still matched by hub_invoice_id and flagged paid-after-void);
 * two concurrent voids can leave a stale "cancel it there" on an order the
 * other one cancelled; a payment that lands after the site cancelled but
 * before the hub void wins the CAS (the invoice shows paid, the void is a
 * no-op; WooCommerce moves the paid order out of cancelled itself unless it
 * hit the plugin's few-ms window).
 */
const wooCommerceProvider: InvoiceProvider = {
  async bind({ workspaceId, integrationId, currency }) {
    const site = await integrationWooCommerceService.credentialsForNewInvoice(
      workspaceId,
      integrationId,
    )
    if (site.currency !== currency) {
      throw validationException(
        "currency",
        `The WooCommerce site ${site.siteSlug} sells in ${site.currency}, not ${currency}`,
      )
    }
    // The origin is the invoice's site identity from the start: a disconnect
    // + reconnect re-adopts drafts too, and payments match by it (s211b).
    return {
      integrationId: site.integrationId,
      providerAccountId: site.siteUrl,
    }
  },
  async connect(invoice) {
    const credentials = await wooCommerceSiteOf(invoice)
    if (!credentials) {
      throw validationException(
        "invoice",
        "This invoice's WooCommerce site is no longer connected",
      )
    }
    return {
      async open() {
        // Everything that can fail runs BEFORE the site creates the order: a
        // throw after it would leave an order the hub never recorded.
        const payToken = mintInvoicePayToken()
        const appUrl = await resolveWorkspaceAppUrl({
          workspaceId: invoice.workspaceId,
        })
        const order = await createWooCommerceOrder({ credentials, invoice })
        const providerInvoiceId = wooCommerceProviderInvoiceId(
          credentials.siteUrl,
          order.orderId,
        )
        return {
          set: {
            status: "open",
            providerInvoiceId,
            providerAccountId: credentials.siteUrl,
            integrationId: credentials.integrationId,
            hostedUrl: order.payUrl,
            payToken,
            pdfUrl: `${invoicePayUrl(appUrl, payToken)}/pdf`,
          },
          // The draft CAS missed. Only a VOID row that names no order yet is
          // ours to claim (a concurrent finalize that won keeps its live
          // order): name the order there (a later payment of it is flagged),
          // then cancel it on the site, and say so by hand when it did not.
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
            if (!claimed) {
              return
            }
            const outcome = await cancelWooCommerceOrder({
              credentials,
              invoice,
              orderId: order.orderId,
            })
            if (outcome.kind !== "cancelled") {
              await recordLastErrorIfClear(
                invoice.id,
                `Voided here while WooCommerce created order ${order.orderId}: cancel it on ${credentials.siteSlug}`,
              )
            }
          },
        }
      },
    }
  },
  async prepareVoid(invoice) {
    // Cancel BEFORE the hub void: a site that says the order is paid refuses it.
    const orderId = wooCommerceOrderIdOf(invoice.providerInvoiceId)
    const before = orderId ? await cancelOnSite(invoice, orderId) : null
    if (orderId && before?.outcome.kind === "paid") {
      throw validationException(
        "invoice",
        `WooCommerce order ${orderId} is already ${before.outcome.orderStatus} on ${before.siteSlug}: refund it in WooCommerce`,
      )
    }
    return {
      async afterVoid(voided) {
        const voidedOrder = wooCommerceOrderIdOf(voided.providerInvoiceId)
        if (!voidedOrder) {
          // A draft: no order exists (an open in flight cancels its own).
          return
        }
        // The voided row names an order the snapshot did not (a finalize
        // opened it meanwhile): cancel that one now, the void already stands.
        const { outcome, siteSlug } =
          voidedOrder === orderId && before
            ? before
            : await cancelOnSite(voided, voidedOrder)
        if (outcome.kind === "cancelled") {
          return
        }
        logger.warn(
          { invoiceId: voided.id, orderId: voidedOrder, outcome },
          "invoice: voided here, but the WooCommerce order was not cancelled",
        )
        await recordLastErrorIfClear(
          voided.id,
          outcome.kind === "paid"
            ? `Voided here, but WooCommerce order ${voidedOrder} is already ${outcome.orderStatus} on ${siteSlug}: refund it in WooCommerce`
            : `Voided here, but WooCommerce order ${voidedOrder} was not cancelled on the site (${outcome.reason.slice(0, 300)}): cancel it there`,
        )
      },
    }
  },
}

/** Every method has a provider: a new enum value fails the typecheck here. */
export const invoiceProviders = {
  stripeInvoice: stripeInvoiceProvider,
  stripeCheckout: stripeCheckoutProvider,
  woocommerce: wooCommerceProvider,
  quickbooks: quickbooksInvoiceProvider,
} satisfies Record<InvoiceMethod, InvoiceProvider>

/**
 * The method and connection a new invoice gets. `default` (or none) is the
 * workspace's Stripe default method, so it needs Stripe connected.
 */
export async function bindNewInvoice(
  requested: RequestedInvoiceMethod | undefined,
  props: BindProps,
): Promise<{
  method: InvoiceMethod
  integrationId: string
  providerAccountId?: string
}> {
  const { workspaceId } = props
  if (!requested || requested === "default") {
    if (props.integrationId) {
      throw validationException(
        "integrationId",
        "integrationId names a WooCommerce site: use it with method woocommerce",
      )
    }
    const credentials =
      await integrationStripeService.credentialsByWorkspaceIdOrFail(workspaceId)
    return {
      method: credentials.defaultMethod,
      integrationId: credentials.integrationId,
    }
  }
  return {
    method: requested,
    ...(await invoiceProviders[requested].bind(props)),
  }
}
