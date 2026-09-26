import { channelTypes } from "@chatbotx.io/database/partials"
import { zodBigintAsString } from "@chatbotx.io/utils"
import { z } from "zod"
import {
  type ContactFilterCriteria,
  parseContactFilterParam,
} from "@/features/contact-filter/schema"

/**
 * Deep-link prefill for the broadcast create page — used by Ads Analytics'
 * per-ad "Retarget → Send WhatsApp broadcast → {segment}" action to land the
 * user on a broadcast with the WhatsApp channel + integration preselected and
 * the contact filter prefilled to that ad's exact segment (see
 * `ads-analytics-view.tsx`'s deep-link builder). Mirrors the
 * `?contactFilter=<JSON>` round-trip already used by the contacts page.
 */
export const createBroadcastPrefillSchema = z.object({
  channel: channelTypes.optional(),
  integrationWhatsappId: zodBigintAsString().optional(),
})
export type CreateBroadcastPrefill = z.infer<
  typeof createBroadcastPrefillSchema
> & {
  contactFilter?: ContactFilterCriteria
  /**
   * The link carried a `contactFilter` that does not parse. The form blocks
   * sending until the operator clears it; it never becomes "everyone" (s206).
   */
  invalidContactFilter: boolean
}

export function parseCreateBroadcastPrefill(
  searchParams: Record<string, unknown>,
): CreateBroadcastPrefill {
  // The filter parses on its own so a bad channel / integration id cannot
  // drop it (and with it the audience restriction).
  const contactFilter = parseContactFilterParam(searchParams.contactFilter)
  const { data } = createBroadcastPrefillSchema.safeParse(searchParams)
  return {
    ...data,
    contactFilter:
      contactFilter.status === "valid" ? contactFilter.filter : undefined,
    invalidContactFilter: contactFilter.status === "invalid",
  }
}
