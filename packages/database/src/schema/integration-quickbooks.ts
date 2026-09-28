import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core"
import {
  bigintAsString,
  sharedColumns,
  timestampConfig,
} from "../partials/shared"
import { contactModel } from "./contact"
import { integrationModel } from "./integration-base"
import { invoiceModel, invoiceStatus } from "./invoice"
import { workspaceModel } from "./workspace"

/**
 * A workspace's OWN QuickBooks Online company (s214b), connected by OAuth
 * with the platform's Intuit app. ONE per workspace. `auth` is
 * `encryptUtils.encryptObject({accessToken, accessExpiresAt, refreshToken,
 * refreshExpiresAt})` (AAD `quickbooks:<integrationId>`); Intuit rotates the
 * refresh token, so every save is a CAS on `tokenVersion`. It serves two
 * jobs: the `quickbooks` invoice method (QBO holds the invoice and takes the
 * payment) and, with `mirrorEnabled`, a bookkeeping copy of every other
 * method's invoices created since `mirrorFrom`.
 */
export const integrationQuickbooksModel = pgTable(
  "IntegrationQuickbooks",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    /** Intuit's company id; every API path is under it. */
    realmId: text().notNull(),
    /** `sandbox` | `production`: the API host this company lives on. */
    environment: text().notNull(),
    companyName: text(),
    /** The company's home currency (ISO 4217). */
    homeCurrency: varchar({ length: 3 }).notNull(),
    /** The company has multicurrency on: other currencies may be invoiced. */
    multicurrency: boolean().notNull().default(false),
    auth: jsonb().notNull(),
    /** Bumped by every token save; a save that read an older one loses. */
    tokenVersion: integer().notNull().default(0),
    tokenRefreshedAt: timestamp(timestampConfig).notNull(),
    /** Set when Intuit refused the refresh token: the owner must reconnect. */
    tokenRefreshError: text(),
    /** The Service item every invoice line is booked against. */
    itemId: text().notNull(),
    mirrorEnabled: boolean().notNull().default(false),
    /** Only invoices created at or after this instant are mirrored. */
    mirrorFrom: timestamp(timestampConfig),
    /** Change-data-capture high-water mark of the paid/void backstop poll. */
    changesSince: timestamp(timestampConfig),
  },
  (table) => [
    uniqueIndex("IntegrationQuickbooks_workspaceId_key").on(table.workspaceId),
    uniqueIndex("IntegrationQuickbooks_integrationId_key").on(
      table.integrationId,
    ),
    uniqueIndex("IntegrationQuickbooks_realmId_key").on(table.realmId),
  ],
)

/**
 * Hub contact -> QBO customer, per integration (like StripeCustomer): a
 * reconnect to another company never reuses a customer id from the old one.
 */
export const quickbooksCustomerModel = pgTable(
  "QuickbooksCustomer",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    contactId: bigintAsString()
      .notNull()
      .references(() => contactModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    customerId: text().notNull(),
  },
  (table) => [
    uniqueIndex("QuickbooksCustomer_integrationId_contactId_key").on(
      table.integrationId,
      table.contactId,
    ),
  ],
)

/**
 * The bookkeeping copy of one hub invoice in one QBO company (s214b). The
 * hub is the source of truth: a sync job converges QBO to the invoice's
 * CURRENT status and records here what it reached (`syncedStatus`), so a
 * lost job is found by the sweep (`syncedStatus` behind the invoice).
 */
export const invoiceMirrorModel = pgTable(
  "InvoiceMirror",
  {
    ...sharedColumns,
    workspaceId: bigintAsString()
      .notNull()
      .references(() => workspaceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    invoiceId: bigintAsString()
      .notNull()
      .references(() => invoiceModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    integrationId: bigintAsString()
      .notNull()
      .references(() => integrationModel.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    externalInvoiceId: text(),
    externalPaymentId: text(),
    syncedStatus: invoiceStatus(),
    lastError: text(),
    attempts: integer().notNull().default(0),
  },
  (table) => [
    uniqueIndex("InvoiceMirror_invoiceId_integrationId_key").on(
      table.invoiceId,
      table.integrationId,
    ),
    index("InvoiceMirror_integrationId_idx").on(table.integrationId),
  ],
)
