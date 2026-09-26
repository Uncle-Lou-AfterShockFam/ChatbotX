import { defineRelationsPart } from "drizzle-orm"
// biome-ignore lint/performance/noNamespaceImport: drizzle schema
import * as schema from "../schema"

export const invoiceRelations = defineRelationsPart(schema, (r) => ({
  integrationStripeModel: {
    integration: r.one.integrationModel({
      from: r.integrationStripeModel.integrationId,
      to: r.integrationModel.id,
    }),
    workspace: r.one.workspaceModel({
      from: r.integrationStripeModel.workspaceId,
      to: r.workspaceModel.id,
    }),
  },
  stripeCustomerModel: {
    contact: r.one.contactModel({
      from: r.stripeCustomerModel.contactId,
      to: r.contactModel.id,
    }),
  },
  invoiceEventModel: {
    invoice: r.one.invoiceModel({
      from: r.invoiceEventModel.invoiceId,
      to: r.invoiceModel.id,
    }),
  },
  invoiceModel: {
    workspace: r.one.workspaceModel({
      from: r.invoiceModel.workspaceId,
      to: r.workspaceModel.id,
    }),
    contact: r.one.contactModel({
      from: r.invoiceModel.contactId,
      to: r.contactModel.id,
    }),
    lineItems: r.many.invoiceLineItemModel({
      from: r.invoiceModel.id,
      to: r.invoiceLineItemModel.invoiceId,
    }),
  },
  invoiceLineItemModel: {
    invoice: r.one.invoiceModel({
      from: r.invoiceLineItemModel.invoiceId,
      to: r.invoiceModel.id,
    }),
  },
}))
