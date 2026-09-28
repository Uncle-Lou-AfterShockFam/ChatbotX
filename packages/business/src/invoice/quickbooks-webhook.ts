import { createHmac, timingSafeEqual } from "node:crypto"
import { and, db, eq, isNull } from "@chatbotx.io/database/client"
import type { InvoiceStatus } from "@chatbotx.io/database/partials"
import {
  integrationQuickbooksModel,
  invoiceEventModel,
  invoiceModel,
} from "@chatbotx.io/database/schema"
import type { InvoiceModel } from "@chatbotx.io/database/types"
import { emitInvoicePaid } from "@chatbotx.io/events"
import type { JobQuickbooksEntityChangedData } from "@chatbotx.io/worker-config"
import { QuickbooksApiError } from "../integration-quickbooks/client"
import {
  quickbooksAppCredential,
  quickbooksConnectionByRealm,
  quickbooksConnectionOf,
} from "../integration-quickbooks/connection"
import {
  getQuickbooksInvoice,
  getQuickbooksPayment,
  isQuickbooksInvoicePaid,
  isQuickbooksInvoiceVoided,
  type QuickbooksInvoice,
  readQuickbooksChanges,
} from "../integration-quickbooks/entities"
import { logger } from "../logger"
import { markInvoiceOnContact } from "./contact-marks"
import { prerenderInvoiceReceipt } from "./document"
import { enqueueQuickbooksChange } from "./quickbooks-jobs"
import {
  quickbooksCallFor,
  quickbooksProviderInvoiceId,
} from "./quickbooks-provider"
import { invoiceEventMetadata, invoiceService } from "./service"

/** Intuit posts at most this many events per notification (the hub's cap). */
export const QUICKBOOKS_WEBHOOK_MAX_EVENTS = 100

/**
 * `intuit-signature`: base64 HMAC-SHA256 of the RAW body keyed with the
 * app's verifier token (developer.intuit.com webhooks, "configure").
 */
export function verifyQuickbooksSignature(props: {
  verifierToken: string
  signature: string | null
  rawBody: Buffer
}): boolean {
  if (!(props.signature && props.verifierToken)) {
    return false
  }
  const expected = createHmac("sha256", props.verifierToken)
    .update(props.rawBody)
    .digest()
  const given = Buffer.from(props.signature, "base64")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

export type QuickbooksNotice = {
  realmId: string
  entity: "Invoice" | "Payment"
  entityId: string
}

const REALM = /^\d{1,32}$/
const ENTITY_ID = /^\d{1,20}$/
/** CloudEvents `type`: `qbo.<entity>.<event>.v<n>`. */
const CLOUD_EVENT_TYPE = /^qbo\.(invoice|payment)\.[a-z]+\.v\d{1,3}$/
const ENTITY_NAMES = new Map<string, QuickbooksNotice["entity"]>([
  ["invoice", "Invoice"],
  ["payment", "Payment"],
  ["Invoice", "Invoice"],
  ["Payment", "Payment"],
])

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

function pushNotice(
  out: QuickbooksNotice[],
  realmId: unknown,
  entity: QuickbooksNotice["entity"] | undefined,
  entityId: unknown,
): void {
  if (
    entity &&
    typeof realmId === "string" &&
    REALM.test(realmId) &&
    typeof entityId === "string" &&
    ENTITY_ID.test(entityId)
  ) {
    out.push({ realmId, entity, entityId })
  }
}

/**
 * The Invoice / Payment changes a notification reports, or null when the body
 * is not a notification (or holds more than the cap). Two shapes: the
 * CloudEvents array Intuit sends since 2026 (`type`, `intuitaccountid`,
 * `intuitentityid`) and the legacy `eventNotifications[].dataChangeEvent`
 * object. Everything else in either is ignored.
 */
export function parseQuickbooksNotification(
  rawBody: Buffer,
): QuickbooksNotice[] | null {
  let data: unknown
  try {
    data = JSON.parse(rawBody.toString("utf8"))
  } catch {
    return null
  }
  const out: QuickbooksNotice[] = []
  if (Array.isArray(data)) {
    if (data.length > QUICKBOOKS_WEBHOOK_MAX_EVENTS) {
      return null
    }
    for (const item of data) {
      const event = asRecord(item)
      const type = typeof event?.type === "string" ? event.type : ""
      const match = CLOUD_EVENT_TYPE.exec(type)
      pushNotice(
        out,
        event?.intuitaccountid,
        match ? ENTITY_NAMES.get(match[1] as string) : undefined,
        event?.intuitentityid,
      )
    }
    return out
  }
  const notifications = asRecord(data)?.eventNotifications
  if (!Array.isArray(notifications)) {
    return null
  }
  if (notifications.length > QUICKBOOKS_WEBHOOK_MAX_EVENTS) {
    return null
  }
  for (const item of notifications) {
    const notification = asRecord(item)
    const entities = asRecord(notification?.dataChangeEvent)?.entities
    if (!Array.isArray(entities)) {
      continue
    }
    if (entities.length > QUICKBOOKS_WEBHOOK_MAX_EVENTS) {
      return null
    }
    for (const raw of entities) {
      const entity = asRecord(raw)
      pushNotice(
        out,
        notification?.realmId,
        typeof entity?.name === "string"
          ? ENTITY_NAMES.get(entity.name)
          : undefined,
        entity?.id,
      )
    }
  }
  return out
}

export type QuickbooksWebhookResult = {
  status: 200 | 401 | 400 | 503
  queued: number
}

/**
 * Intuit's ONE app-wide webhook (s214b). It must answer within 3 s, so it
 * only verifies (the platform app's verifier token), parses and queues one
 * job per known company's Invoice / Payment; an unknown company is ignored.
 * 401 = bad signature, 400 = not a notification, 503 = retry (Intuit backs
 * off 10 s ... 6 h and holds later events until this one is acknowledged).
 */
export async function handleQuickbooksWebhook(props: {
  rawBody: Buffer
  signature: string | null
}): Promise<QuickbooksWebhookResult> {
  let verifierToken: string
  try {
    verifierToken = (await quickbooksAppCredential()).webhookVerifierToken
  } catch {
    return { status: 401, queued: 0 }
  }
  if (
    !verifyQuickbooksSignature({
      verifierToken,
      signature: props.signature,
      rawBody: props.rawBody,
    })
  ) {
    return { status: 401, queued: 0 }
  }
  const notices = parseQuickbooksNotification(props.rawBody)
  if (!notices) {
    return { status: 400, queued: 0 }
  }
  let queued = 0
  const connections = new Map<
    string,
    Awaited<ReturnType<typeof quickbooksConnectionByRealm>>
  >()
  try {
    for (const notice of notices) {
      if (!connections.has(notice.realmId)) {
        connections.set(
          notice.realmId,
          await quickbooksConnectionByRealm(notice.realmId),
        )
      }
      const connection = connections.get(notice.realmId)
      if (!connection) {
        continue
      }
      await enqueueQuickbooksChange(
        {
          workspaceId: connection.workspaceId,
          integrationId: connection.integrationId,
          entity: notice.entity,
          entityId: notice.entityId,
        },
        "webhook",
      )
      queued += 1
    }
  } catch (error) {
    logger.error({ err: error }, "quickbooks webhook: enqueue failed")
    return { status: 503, queued }
  }
  return { status: 200, queued }
}

/** What the hub did with one QBO invoice reading. */
export type QuickbooksSettleOutcome =
  | "not-hub"
  | "paid"
  | "voided"
  | "paid-after-void"
  | "unpaid-after-paid"
  | "unchanged"

/**
 * A hub invoice marked paid whose QBO invoice owes money again (its payment
 * was deleted or reversed in QuickBooks). The hub never un-pays (`paid` has
 * no way back), so it says so on the invoice for a human, once.
 */
async function flagUnpaidInQuickbooks(
  props: { integrationId: string; qbo: QuickbooksInvoice },
  providerInvoiceId: string,
): Promise<QuickbooksSettleOutcome> {
  if ((props.qbo.balance ?? 0) <= 0) {
    return "unchanged"
  }
  const [flagged] = await db
    .update(invoiceModel)
    .set({
      lastError: `QuickBooks shows invoice ${props.qbo.id} unpaid again (its payment was deleted or reversed there): check it`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(invoiceModel.providerInvoiceId, providerInvoiceId),
        eq(invoiceModel.method, "quickbooks"),
        eq(invoiceModel.integrationId, props.integrationId),
        eq(invoiceModel.status, "paid"),
        isNull(invoiceModel.lastError),
      ),
    )
    .returning({ id: invoiceModel.id })
  return flagged ? "unpaid-after-paid" : "unchanged"
}

async function dropEvent(integrationId: string, providerEventId: string) {
  try {
    await db
      .delete(invoiceEventModel)
      .where(
        and(
          eq(invoiceEventModel.integrationId, integrationId),
          eq(invoiceEventModel.providerEventId, providerEventId),
        ),
      )
  } catch (error) {
    logger.error(
      { err: error, providerEventId },
      "quickbooks: dedup row not removed; this change's retry will be skipped",
    )
  }
}

/**
 * Apply one QBO invoice reading to its hub invoice (only a `quickbooks`
 * method invoice: a mirror copy is never driven by QuickBooks). One
 * transaction locks the invoice, inserts the per-integration InvoiceEvent
 * (keyed by the OUTCOME, so a payment is applied and marked once however
 * many notices report it) and moves the status by CAS. Paid after a hub
 * void is flagged, never applied. Marks/events failing drops the dedup row
 * and throws, so the job retries.
 */
export async function settleQuickbooksInvoice(props: {
  integrationId: string
  realmId: string
  qbo: QuickbooksInvoice
}): Promise<QuickbooksSettleOutcome> {
  const providerInvoiceId = quickbooksProviderInvoiceId(
    props.realmId,
    props.qbo.id,
  )
  const paid = isQuickbooksInvoicePaid(props.qbo)
  const voided = !paid && isQuickbooksInvoiceVoided(props.qbo)
  if (!(paid || voided)) {
    return await flagUnpaidInQuickbooks(props, providerInvoiceId)
  }
  type Decision =
    | { kind: "not-hub" | "unchanged" | "paid-after-void" }
    | {
        kind: "applied"
        invoice: InvoiceModel
        target: InvoiceStatus
        eventId: string
      }
  let decision: Decision = { kind: "unchanged" }
  await db.transaction(async (tx) => {
    const [invoice] = await tx
      .select()
      .from(invoiceModel)
      .where(
        and(
          eq(invoiceModel.providerInvoiceId, providerInvoiceId),
          eq(invoiceModel.method, "quickbooks"),
          eq(invoiceModel.integrationId, props.integrationId),
        ),
      )
      .limit(1)
      .for("update")
    if (!invoice) {
      decision = { kind: "not-hub" }
      return
    }
    const target: InvoiceStatus = paid ? "paid" : "void"
    const paidAfterVoid = paid && invoice.status === "void"
    const eventId = `qbo:invoice:${props.qbo.id}:${paidAfterVoid ? "paid-after-void" : target}`
    const [row] = await tx
      .insert(invoiceEventModel)
      .values({
        workspaceId: invoice.workspaceId,
        integrationId: props.integrationId,
        invoiceId: invoice.id,
        providerEventId: eventId,
        type: `quickbooks.invoice.${target}`,
        outcome: "received",
      })
      .onConflictDoNothing()
      .returning({ id: invoiceEventModel.id })
    if (!row) {
      decision = { kind: "unchanged" }
      return
    }
    if (paidAfterVoid) {
      await tx
        .update(invoiceModel)
        .set({
          lastError: `Paid in QuickBooks (invoice ${props.qbo.id}) after it was voided here: refund it in QuickBooks`,
          updatedAt: new Date(),
        })
        .where(eq(invoiceModel.id, invoice.id))
      await tx
        .update(invoiceEventModel)
        .set({ outcome: "paid-after-void", updatedAt: new Date() })
        .where(eq(invoiceEventModel.id, row.id))
      decision = { kind: "paid-after-void" }
      return
    }
    const applied = await invoiceService.transition({
      invoiceId: invoice.id,
      to: target,
      set:
        target === "paid" ? { paidAt: new Date() } : { voidedAt: new Date() },
      tx,
    })
    if (applied) {
      decision = { kind: "applied", invoice: applied, target, eventId }
      return
    }
    if (invoice.status === target) {
      // Already in this status: the marks run only if they never completed
      // (a retry after a failed mark dropped the event row).
      const [marked] = await tx
        .select({ id: invoiceEventModel.id })
        .from(invoiceEventModel)
        .where(
          and(
            eq(invoiceEventModel.invoiceId, invoice.id),
            eq(invoiceEventModel.outcome, `marked:${target}`),
          ),
        )
        .limit(1)
      if (!marked) {
        decision = { kind: "applied", invoice, target, eventId }
        return
      }
    }
    await tx
      .update(invoiceEventModel)
      .set({ outcome: `ignored:${invoice.status}`, updatedAt: new Date() })
      .where(eq(invoiceEventModel.id, row.id))
    decision = { kind: "unchanged" }
  })
  const outcome = decision as Decision
  if (outcome.kind !== "applied") {
    return outcome.kind
  }
  try {
    await markInvoiceOnContact({
      invoice: outcome.invoice,
      status: outcome.target,
    })
    if (outcome.target === "paid") {
      await emitInvoicePaid(
        outcome.invoice.workspaceId,
        outcome.invoice.contactId,
        invoiceEventMetadata(outcome.invoice),
      )
    }
  } catch (error) {
    // The status already moved: the retry finds no `marked:` row and runs
    // the marks again (the dedup row is dropped so it can be re-inserted).
    await dropEvent(props.integrationId, outcome.eventId)
    throw error
  }
  await db
    .update(invoiceEventModel)
    .set({ outcome: `marked:${outcome.target}`, updatedAt: new Date() })
    .where(
      and(
        eq(invoiceEventModel.integrationId, props.integrationId),
        eq(invoiceEventModel.providerEventId, outcome.eventId),
      ),
    )
  if (outcome.target === "paid") {
    prerenderInvoiceReceipt(outcome.invoice.id).catch(() => undefined)
  }
  return outcome.target === "paid" ? "paid" : "voided"
}

/**
 * The `quickbooksEntityChanged` job: read the changed Invoice (or every
 * invoice a Payment pays) from QBO and settle each. A Payment QBO no longer
 * has (deleted) settles nothing. Throws on a retryable QBO failure.
 */
export async function processQuickbooksChange(
  data: JobQuickbooksEntityChangedData,
): Promise<QuickbooksSettleOutcome[]> {
  const connection = await quickbooksConnectionOf(data.workspaceId)
  if (!connection || connection.integrationId !== data.integrationId) {
    return []
  }
  const call = quickbooksCallFor(connection.integrationId)
  const read = async (id: string) => {
    try {
      return await getQuickbooksInvoice(call, id)
    } catch (error) {
      if (error instanceof QuickbooksApiError && error.status === 400) {
        return null
      }
      throw error
    }
  }
  let invoiceIds: string[] = [data.entityId]
  if (data.entity === "Payment") {
    let payment: Awaited<ReturnType<typeof getQuickbooksPayment>> = null
    try {
      payment = await getQuickbooksPayment(call, data.entityId)
    } catch (error) {
      if (!(error instanceof QuickbooksApiError && error.status === 400)) {
        throw error
      }
    }
    invoiceIds = payment?.invoiceIds.slice(0, 100) ?? []
  }
  const outcomes: QuickbooksSettleOutcome[] = []
  for (const id of invoiceIds) {
    const qbo = await read(id)
    if (qbo) {
      outcomes.push(
        await settleQuickbooksInvoice({
          integrationId: connection.integrationId,
          realmId: connection.realmId,
          qbo,
        }),
      )
    }
  }
  return outcomes
}

/** CDC can look back 30 days; the poll never asks for more than 29. */
const CDC_MAX_LOOKBACK_MS = 29 * 86_400_000
/** Re-read a minute of overlap: a change stamped during the last poll is not lost. */
const CDC_OVERLAP_MS = 60_000

/**
 * The backstop for lost webhooks (every 15 min): each healthy company's
 * Invoice / Payment changes since its high-water mark are queued like
 * webhook notices, then the mark moves to this poll's start. One company's
 * failure never stops the others.
 */
export async function pollQuickbooksChanges(
  now = new Date(),
): Promise<{ companies: number; queued: number; failed: number }> {
  const rows = await db.query.integrationQuickbooksModel.findMany({
    where: { tokenRefreshError: { isNull: true } },
    columns: {
      id: true,
      workspaceId: true,
      integrationId: true,
      changesSince: true,
    },
    limit: 500,
  })
  let queued = 0
  let failed = 0
  for (const row of rows) {
    const floor = now.getTime() - CDC_MAX_LOOKBACK_MS
    const since = new Date(
      Math.max(floor, (row.changesSince ?? now).getTime() - CDC_OVERLAP_MS),
    )
    try {
      const changes = await readQuickbooksChanges(
        quickbooksCallFor(row.integrationId),
        since,
      )
      // A page that hit CDC's 1000-object cap may hide older changes: move
      // the mark only to the newest change seen, and read on next time.
      const truncated =
        changes.filter((c) => c.entity === "Invoice").length >= 1000 ||
        changes.filter((c) => c.entity === "Payment").length >= 1000
      const newest = changes
        .map((c) => Date.parse(c.lastUpdated ?? ""))
        .filter(Number.isFinite)
        .reduce((a, b) => Math.max(a, b), since.getTime())
      for (const change of changes) {
        if (change.deleted) {
          continue
        }
        await enqueueQuickbooksChange(
          {
            workspaceId: row.workspaceId,
            integrationId: row.integrationId,
            entity: change.entity,
            entityId: change.id,
          },
          "poll",
        )
        queued += 1
      }
      await db
        .update(integrationQuickbooksModel)
        .set({
          changesSince: truncated ? new Date(newest) : now,
          updatedAt: new Date(),
        })
        .where(eq(integrationQuickbooksModel.id, row.id))
    } catch (error) {
      failed += 1
      logger.warn(
        { err: error, integrationId: row.integrationId },
        "quickbooks: change poll failed",
      )
    }
  }
  return { companies: rows.length, queued, failed }
}
