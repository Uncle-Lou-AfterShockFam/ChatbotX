import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { contactModel } from "./contact"
import { integrationModel } from "./integration-base"
import { invoiceMethod } from "./invoice"
import { workspaceModel } from "./workspace"

/**
 * A workspace's OWN Stripe account (s205b): money goes to the workspace, never
 * to the platform. `auth` is `encryptUtils.encryptObject({secretKey,
 * webhookSecret})`; it never leaves the server. `webhookEndpointId` is the
 * endpoint the hub created on connect (null when the secret was pasted).
 */
export const integrationStripeModel = pgTable(
  "IntegrationStripe",
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
    auth: jsonb().notNull(),
    accountId: text().notNull(),
    accountName: text(),
    livemode: boolean().notNull(),
    keyLast4: text().notNull(),
    webhookEndpointId: text(),
    /** What a create that asks for method `default` uses (s207b). */
    defaultMethod: invoiceMethod().notNull().default("stripeInvoice"),
    /**
     * `STRIPE_WEBHOOK_EVENTS_VERSION` the endpoint was last subscribed with;
     * an older endpoint is upgraded in place before a method needs its events.
     */
    webhookEventsVersion: integer().notNull().default(1),
  },
  (table) => [
    uniqueIndex("IntegrationStripe_workspaceId_key").on(table.workspaceId),
    uniqueIndex("IntegrationStripe_integrationId_key").on(table.integrationId),
  ],
)

/**
 * Hub contact -> Stripe customer, per integration: reconnecting a different
 * Stripe account must not reuse a customer id from the old one.
 */
export const stripeCustomerModel = pgTable(
  "StripeCustomer",
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
    uniqueIndex("StripeCustomer_integrationId_contactId_key").on(
      table.integrationId,
      table.contactId,
    ),
  ],
)
