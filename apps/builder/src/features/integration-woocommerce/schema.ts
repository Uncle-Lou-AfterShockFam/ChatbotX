import {
  WOOCOMMERCE_ACTION_TOKEN_PATTERN,
  WOOCOMMERCE_SITE_SLUG_PATTERN,
} from "@chatbotx.io/database/partials"
import { z } from "zod"

/** Settings > Integrations > WooCommerce: link one site (s211b). */
export const connectWooCommerceSchema = z
  .object({
    siteSlug: z.string().trim().regex(WOOCOMMERCE_SITE_SLUG_PATTERN, {
      message: "The site's HUBC_SITE_SLUG (lowercase letters, digits, -)",
    }),
    siteUrl: z.url({ protocol: /^https$/, message: "https://your-site.org" }),
    actionToken: z.string().trim().regex(WOOCOMMERCE_ACTION_TOKEN_PATTERN, {
      message: "A hub-connector action token (btc_...)",
    }),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3}$/, { message: "The store currency, e.g. USD" }),
  })
  .strict()
export type ConnectWooCommerceValues = z.infer<typeof connectWooCommerceSchema>
