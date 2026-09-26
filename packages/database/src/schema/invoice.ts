import {
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import {
  type InvoiceMethod,
  type InvoiceStatus,
  invoiceMethods,
  invoiceStatuses,
} from "../partials/invoice"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { companyModel } from "./company"
import { contactModel } from "./contact"
import { dealModel } from "./deal"
import { integrationModel } from "./integration-base"
import { workspaceModel } from "./workspace"

export const invoiceStatus = pgEnum(
  "invoiceStatus",
  invoiceStatuses.options as [InvoiceStatus, ...InvoiceStatus[]],
)

export const invoiceMethod = pgEnum(
  "invoiceMethod",
  invoiceMethods.options as [InvoiceMethod, ...InvoiceMethod[]],
)

/**
 * The hub's invoice ledger (s205b). Money is numeric(14,2) strings plus an ISO
 * currency; minor units exist only at the provider boundary. `number` is per
 * workspace (allocated max+1 inside the create transaction, the unique index
 * arbitrates a race). `sourceKey` makes a create idempotent: a flow retry or
 * an API Idempotency-Key replay returns the first invoice. `integrationId` is
 * SET NULL so disconnecting Stripe keeps the ledger; reconnecting the same
 * Stripe account (`providerAccountId`) re-adopts those invoices.
 */
export const invoiceModel = pgTable(
  "Invoice",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    number: integer().notNull(),
    status: invoiceStatus().notNull().default("draft"),
    method: invoiceMethod().notNull(),
    currency: varchar({ length: 3 }).notNull(),
    total: numeric({ precision: 14, scale: 2 }).notNull(),
    memo: text(),
    dueAt: timestamp(timestampConfig),
    paidAt: timestamp(timestampConfig),
    voidedAt: timestamp(timestampConfig),
    sourceKey: text(),
    /** sha256 of the create request; a sourceKey replay with other content is refused. */
    requestHash: text(),
    lastError: text(),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    companyId: bigintAsString().references(() => companyModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    dealId: bigintAsString().references(() => dealModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    integrationId: bigintAsString().references(() => integrationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    providerInvoiceId: text(),
    /** The Stripe account that holds `providerInvoiceId` (re-adopted on reconnect). */
    providerAccountId: text(),
    providerCustomerId: text(),
    hostedUrl: text(),
    pdfUrl: text(),
  },
  (table) => [
    uniqueIndex("Invoice_workspaceId_number_key").on(
      table.workspaceId,
      table.number,
    ),
    uniqueIndex("Invoice_workspaceId_sourceKey_key").on(
      table.workspaceId,
      table.sourceKey,
    ),
    uniqueIndex("Invoice_providerInvoiceId_key").on(table.providerInvoiceId),
    index("Invoice_workspaceId_createdAt_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
    index("Invoice_workspaceId_contactId_idx").on(
      table.workspaceId,
      table.contactId,
    ),
  ],
)

export const invoiceLineItemModel = pgTable(
  "InvoiceLineItem",
  {
    ...sharedColumns,
    invoiceId: bigintAsString()
      .notNull()
      .references(() => invoiceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    position: integer().notNull(),
    description: text().notNull(),
    quantity: integer().notNull(),
    unitAmount: numeric({ precision: 14, scale: 2 }).notNull(),
    amount: numeric({ precision: 14, scale: 2 }).notNull(),
  },
  (table) => [
    uniqueIndex("InvoiceLineItem_invoiceId_position_key").on(
      table.invoiceId,
      table.position,
    ),
  ],
)

/**
 * One row per provider webhook event: the unique (integrationId,
 * providerEventId) index IS the webhook dedup, inserted in the same
 * transaction as the state change it causes.
 */
export const invoiceEventModel = pgTable(
  "InvoiceEvent",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    /** SET NULL: a disconnect keeps the audit trail of surviving invoices. */
    integrationId: bigintAsString().references(() => integrationModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    invoiceId: bigintAsString().references(() => invoiceModel.id, {
      onDelete: "set null",
      onUpdate: "cascade",
    }),
    providerEventId: text().notNull(),
    type: text().notNull(),
    outcome: text().notNull(),
  },
  (table) => [
    uniqueIndex("InvoiceEvent_integrationId_providerEventId_key").on(
      table.integrationId,
      table.providerEventId,
    ),
    index("InvoiceEvent_invoiceId_idx").on(table.invoiceId),
  ],
)
