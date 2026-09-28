import {
  and,
  db,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from "@chatbotx.io/database/client"
import { invoiceMirrorModel, invoiceModel } from "@chatbotx.io/database/schema"
import type {
  InvoiceMirrorModel,
  InvoiceModel,
} from "@chatbotx.io/database/types"
import { distributedLock } from "@chatbotx.io/redis"
import { DefaultJobAction, defaultQueue } from "@chatbotx.io/worker-config"
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
  quickbooksConnectionOf,
} from "../integration-quickbooks/connection"
import {
  createQuickbooksPayment,
  findQuickbooksInvoiceByMarker,
  findQuickbooksPaymentByMarker,
  type QuickbooksCall,
  quickbooksHubMarker,
  voidQuickbooksInvoice,
} from "../integration-quickbooks/entities"
import { logger } from "../logger"
import { quickbooksCallFor } from "./quickbooks-provider"

/**
 * The QuickBooks bookkeeping mirror (s214b). Every invoice collected by
 * another method (Stripe, Checkout, WooCommerce) and created since the
 * company's `mirrorFrom` is copied into QBO: an Invoice once it is open, a
 * Payment (to Undeposited Funds, QBO's default) once paid, a void once
 * voided. The hub is the source of truth: a sync reads the invoice's
 * CURRENT status and converges QBO to it, so a lost or reordered job is
 * harmless and the hourly sweep finds anything left behind. QBO never
 * drives a mirrored invoice.
 */

/** A mirror row this many failed tries in is left to the next status change. */
export const MIRROR_MAX_ATTEMPTS = 5
/** Invoices per sweep run (per company). */
export const MIRROR_SWEEP_LIMIT = 500
const MIRROR_LOCK_SECONDS = 120

/** The statuses a mirror copies; the others are noted, never written. */
const MIRRORED: readonly InvoiceModel["status"][] = ["open", "paid", "void"]

export type MirrorOutcome =
  | "skipped"
  | "unchanged"
  | "synced"
  | "noted"
  | "failed-permanent"

const eligible = (
  invoice: InvoiceModel,
  connection: QuickbooksConnection | null,
): connection is QuickbooksConnection =>
  !!connection &&
  connection.mirrorEnabled &&
  !!connection.mirrorFrom &&
  !connection.tokenRefreshError &&
  invoice.method !== "quickbooks" &&
  invoice.status !== "draft" &&
  invoice.createdAt >= connection.mirrorFrom

/** Queue a sync for this invoice's current status; never throws. */
export async function enqueueInvoiceMirror(
  invoice: Pick<InvoiceModel, "id" | "workspaceId" | "status" | "method">,
): Promise<void> {
  if (invoice.method === "quickbooks" || invoice.status === "draft") {
    return
  }
  try {
    const connection = await quickbooksConnectionOf(invoice.workspaceId)
    if (!connection?.mirrorEnabled) {
      return
    }
    await defaultQueue.add(
      DefaultJobAction.syncInvoiceMirror,
      {
        type: DefaultJobAction.syncInvoiceMirror,
        data: { workspaceId: invoice.workspaceId, invoiceId: invoice.id },
      },
      { jobId: `invoice-mirror-${invoice.id}-${invoice.status}` },
    )
  } catch (error) {
    logger.warn(
      { err: error, invoiceId: invoice.id },
      "invoice mirror: enqueue failed (the sweep will find it)",
    )
  }
}

async function mirrorRowFor(
  invoice: InvoiceModel,
  integrationId: string,
): Promise<InvoiceMirrorModel> {
  await db
    .insert(invoiceMirrorModel)
    .values({
      workspaceId: invoice.workspaceId,
      invoiceId: invoice.id,
      integrationId,
    })
    .onConflictDoNothing()
  const row = await db.query.invoiceMirrorModel.findFirst({
    where: { invoiceId: invoice.id, integrationId },
  })
  if (!row) {
    throw new Error("invoice mirror: row not written")
  }
  return row
}

const recordMirror = (
  rowId: string,
  set: Partial<
    Pick<
      InvoiceMirrorModel,
      | "externalInvoiceId"
      | "externalPaymentId"
      | "syncedStatus"
      | "lastError"
      | "attempts"
    >
  >,
) =>
  db
    .update(invoiceMirrorModel)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(invoiceMirrorModel.id, rowId))

const isPermanent = (error: unknown): boolean =>
  error instanceof QuickbooksBooksError ||
  error instanceof QuickbooksReconnectRequiredError ||
  (error instanceof QuickbooksApiError && !error.retryable)

/**
 * Converge the QBO copy of one invoice to its current status, under a
 * per-invoice lock. Returns the outcome; throws only on a retryable failure
 * (after counting the attempt), so the job retries it.
 */
export async function syncInvoiceMirror(props: {
  workspaceId: string
  invoiceId: string
}): Promise<MirrorOutcome> {
  return await distributedLock.runExclusive({
    key: `invoice-mirror:${props.invoiceId}`,
    timeoutInSeconds: MIRROR_LOCK_SECONDS,
    fn: () => syncLocked(props),
  })
}

async function syncLocked(props: {
  workspaceId: string
  invoiceId: string
}): Promise<MirrorOutcome> {
  const invoice = await db.query.invoiceModel.findFirst({
    where: { id: props.invoiceId, workspaceId: props.workspaceId },
    with: { lineItems: { orderBy: { position: "asc" } } },
  })
  if (!invoice) {
    return "skipped"
  }
  const connection = await quickbooksConnectionOf(invoice.workspaceId)
  if (!eligible(invoice, connection)) {
    return "skipped"
  }
  const row = await mirrorRowFor(invoice, connection.integrationId)
  if (row.syncedStatus === invoice.status) {
    return "unchanged"
  }
  if (!MIRRORED.includes(invoice.status)) {
    await recordMirror(row.id, {
      syncedStatus: invoice.status,
      lastError: `A ${invoice.status} invoice is not mirrored to QuickBooks: adjust it there by hand`,
    })
    return "noted"
  }
  const call = quickbooksCallFor(connection.integrationId)
  if (invoice.status === "void" && !row.externalInvoiceId) {
    return await voidWithoutRecordedCopy({ invoice, connection, row, call })
  }
  try {
    assertQuickbooksCurrency(connection, invoice.currency)
    const { customerId } = await ensureQuickbooksCustomer({
      call,
      connection,
      invoice,
    })
    let externalInvoiceId = row.externalInvoiceId
    let note: string | null = null
    if (!externalInvoiceId) {
      const result = await upsertQuickbooksInvoice({
        call,
        connection,
        invoice,
        lines: invoice.lineItems,
        customerId,
        collect: null,
        attemptKey: `m${row.attempts}`,
      })
      externalInvoiceId = result.qbo.id
      await recordMirror(row.id, { externalInvoiceId })
      if (!result.totalMatches) {
        note = `QuickBooks totals invoice ${externalInvoiceId} at ${result.qbo.totalAmt ?? "?"}, not ${invoice.total} (sales tax on the "Hub sales" item?)`
      }
    }
    if (invoice.status === "paid" && !row.externalPaymentId) {
      const marker = quickbooksHubMarker(invoice.id)
      const payment =
        (await findQuickbooksPaymentByMarker(call, {
          customerId,
          marker,
          since: invoice.createdAt,
        })) ??
        (await createQuickbooksPayment(call, {
          body: {
            CustomerRef: { value: customerId },
            TotalAmt: Number(invoice.total),
            TxnDate: (invoice.paidAt ?? new Date()).toISOString().slice(0, 10),
            PrivateNote: `Hub invoice #${invoice.number} paid via ${invoice.method} ${marker}`,
            ...(connection.multicurrency
              ? { CurrencyRef: { value: invoice.currency } }
              : {}),
            // No DepositToAccountRef: QBO books it to Undeposited Funds.
            Line: [
              {
                Amount: Number(invoice.total),
                LinkedTxn: [{ TxnId: externalInvoiceId, TxnType: "Invoice" }],
              },
            ],
          },
          requestId: `hub-pay-${invoice.id}-m${row.attempts}`,
        }))
      await recordMirror(row.id, { externalPaymentId: payment.id })
    }
    if (invoice.status === "void") {
      if (row.externalPaymentId) {
        note = `Voided here, but QuickBooks already holds payment ${row.externalPaymentId}: reverse it there`
      } else {
        await voidQuickbooksInvoice(call, externalInvoiceId)
      }
    }
    await recordMirror(row.id, {
      syncedStatus: invoice.status,
      lastError: note,
      attempts: 0,
    })
    return "synced"
  } catch (error) {
    return await recordFailure(row, error)
  }
}

/**
 * Voided before a copy was recorded: nothing to write, unless an attempt
 * created one and died before recording it (found by the hub marker, and
 * only for a contact this company already has a customer for).
 */
async function voidWithoutRecordedCopy(props: {
  invoice: InvoiceModel
  connection: QuickbooksConnection
  row: InvoiceMirrorModel
  call: QuickbooksCall
}): Promise<MirrorOutcome> {
  const { invoice, row, call } = props
  try {
    const customer = await db.query.quickbooksCustomerModel.findFirst({
      where: {
        integrationId: props.connection.integrationId,
        contactId: invoice.contactId,
      },
    })
    const orphan = customer
      ? await findQuickbooksInvoiceByMarker(call, {
          customerId: customer.customerId,
          marker: quickbooksHubMarker(invoice.id),
          since: invoice.createdAt,
        })
      : null
    if (orphan && !orphan.privateNote?.startsWith("Voided")) {
      await recordMirror(row.id, { externalInvoiceId: orphan.id })
      await voidQuickbooksInvoice(call, orphan.id)
    }
    await recordMirror(row.id, {
      syncedStatus: "void",
      lastError: null,
      attempts: 0,
    })
    return "synced"
  } catch (error) {
    return await recordFailure(row, error)
  }
}

async function recordFailure(
  row: InvoiceMirrorModel,
  error: unknown,
): Promise<MirrorOutcome> {
  const permanent = isPermanent(error)
  await recordMirror(row.id, {
    lastError: (error instanceof Error ? error.message : "failed").slice(
      0,
      1000,
    ),
    attempts: permanent ? MIRROR_MAX_ATTEMPTS : row.attempts + 1,
  })
  if (permanent) {
    return "failed-permanent"
  }
  throw error
}

/**
 * The hourly backstop: per mirroring company, the eligible invoices whose
 * copy is missing or behind their status (and not given up on) are queued
 * again, at most MIRROR_SWEEP_LIMIT each. The job id carries the hour, so a
 * job that failed for good under its status id is not a permanent block.
 */
export async function sweepInvoiceMirrors(
  now = new Date(),
): Promise<{ queued: number }> {
  const connections = await db.query.integrationQuickbooksModel.findMany({
    where: { mirrorEnabled: true, tokenRefreshError: { isNull: true } },
    columns: { workspaceId: true, integrationId: true, mirrorFrom: true },
    limit: 500,
  })
  const hour = Math.floor(now.getTime() / 3_600_000)
  let queued = 0
  for (const connection of connections) {
    if (!connection.mirrorFrom) {
      continue
    }
    const behind = await db
      .select({ id: invoiceModel.id })
      .from(invoiceModel)
      .leftJoin(
        invoiceMirrorModel,
        and(
          eq(invoiceMirrorModel.invoiceId, invoiceModel.id),
          eq(invoiceMirrorModel.integrationId, connection.integrationId),
        ),
      )
      .where(
        and(
          eq(invoiceModel.workspaceId, connection.workspaceId),
          ne(invoiceModel.method, "quickbooks"),
          inArray(invoiceModel.status, [
            "open",
            "paid",
            "void",
            "refunded",
            "uncollectible",
          ]),
          gte(invoiceModel.createdAt, connection.mirrorFrom),
          or(
            isNull(invoiceMirrorModel.id),
            and(
              sql`${invoiceMirrorModel.syncedStatus} is distinct from ${invoiceModel.status}`,
              lt(invoiceMirrorModel.attempts, MIRROR_MAX_ATTEMPTS),
            ),
          ),
        ),
      )
      .limit(MIRROR_SWEEP_LIMIT)
    for (const { id } of behind) {
      try {
        await defaultQueue.add(
          DefaultJobAction.syncInvoiceMirror,
          {
            type: DefaultJobAction.syncInvoiceMirror,
            data: { workspaceId: connection.workspaceId, invoiceId: id },
          },
          { jobId: `invoice-mirror-sweep-${id}-${hour}` },
        )
        queued += 1
      } catch (error) {
        logger.warn(
          { err: error, invoiceId: id },
          "invoice mirror: sweep enqueue failed",
        )
      }
    }
  }
  return { queued }
}

export type InvoiceBookkeepingState = {
  state: "synced" | "pending" | "error"
  error: string | null
}

/**
 * The QuickBooks copy state of each listed invoice the mirror covers (one
 * query per page, never per row). Invoices it does not cover (mirror off, a
 * quickbooks-method or draft invoice, one older than `mirrorFrom`) have no
 * entry.
 */
export async function invoiceBookkeepingStates(props: {
  workspaceId: string
  invoices: Pick<InvoiceModel, "id" | "status" | "method" | "createdAt">[]
}): Promise<Map<string, InvoiceBookkeepingState>> {
  const states = new Map<string, InvoiceBookkeepingState>()
  const connection = await quickbooksConnectionOf(props.workspaceId)
  if (!(connection?.mirrorEnabled && connection.mirrorFrom)) {
    return states
  }
  const mirrorFrom = connection.mirrorFrom
  const covered = props.invoices
    .slice(0, 200)
    .filter(
      (invoice) =>
        invoice.method !== "quickbooks" &&
        invoice.status !== "draft" &&
        invoice.createdAt >= mirrorFrom,
    )
  if (covered.length === 0) {
    return states
  }
  const rows = await db
    .select({
      invoiceId: invoiceMirrorModel.invoiceId,
      syncedStatus: invoiceMirrorModel.syncedStatus,
      lastError: invoiceMirrorModel.lastError,
    })
    .from(invoiceMirrorModel)
    .where(
      and(
        eq(invoiceMirrorModel.integrationId, connection.integrationId),
        inArray(
          invoiceMirrorModel.invoiceId,
          covered.map((invoice) => invoice.id),
        ),
      ),
    )
  const byInvoice = new Map(rows.map((row) => [row.invoiceId, row]))
  for (const invoice of covered) {
    const row = byInvoice.get(invoice.id)
    if (row?.lastError) {
      states.set(invoice.id, { state: "error", error: row.lastError })
    } else if (row?.syncedStatus === invoice.status) {
      states.set(invoice.id, { state: "synced", error: null })
    } else {
      states.set(invoice.id, { state: "pending", error: null })
    }
  }
  return states
}
