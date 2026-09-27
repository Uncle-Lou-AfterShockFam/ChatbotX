import { jsonb, pgTable, text, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { bigintAsString, sharedColumns } from "../partials/shared"
import { integrationModel } from "./integration-base"
import { workspaceModel } from "./workspace"

/**
 * A WordPress + WooCommerce site linked to a workspace (s211b): the
 * `woocommerce` invoice method creates its orders there. MANY per workspace
 * (one hub may serve several sites), each its own Integration row, so an
 * invoice names its site by `Invoice.integrationId` and a payment dedups per
 * site (`InvoiceEvent`). `auth` is `encryptUtils.encryptObject({actionToken,
 * webhookSecret})`: the site's `btc_` token (scope `orders:write`) for
 * `order.invoice`, and the `whsec_` secret the HUB generated for the site's
 * `HUBC_HUB_SECRET` (the site signs `order.paid` with it). Neither leaves the
 * server after connect.
 */
export const integrationWooCommerceModel = pgTable(
  "IntegrationWooCommerce",
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
    /** The site's HUBC_SITE_SLUG: its name in pickers and logs. */
    siteSlug: text().notNull(),
    /** https origin, no path: `order.invoice` is POSTed under it. */
    siteUrl: text().notNull(),
    auth: jsonb().notNull(),
    tokenLast4: text().notNull(),
    /** The store currency (ISO 4217): an invoice in another currency is refused. */
    currency: varchar({ length: 3 }).notNull(),
  },
  (table) => [
    uniqueIndex("IntegrationWooCommerce_integrationId_key").on(
      table.integrationId,
    ),
    uniqueIndex("IntegrationWooCommerce_workspaceId_siteSlug_key").on(
      table.workspaceId,
      table.siteSlug,
    ),
  ],
)
