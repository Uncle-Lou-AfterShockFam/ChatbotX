import { assertPublicUrl } from "@chatbotx.io/business"
import { outboundFetch } from "@chatbotx.io/business/outbound-fetch"
import { signApiPayload } from "./signature"

const DELIVERY_TIMEOUT_MS = 30_000

/** The callback answered non-2xx (ky threw HTTPError here before s216). */
export class DeliveryHttpError extends Error {
  readonly status: number

  constructor(status: number, url: string) {
    super(`API channel callback answered ${status}: ${url}`)
    this.name = "DeliveryHttpError"
    this.status = status
  }
}

export type DeliveryResponse = {
  messageId?: string
}

/**
 * Sign and POST an outbound envelope to the customer's callback URL.
 * `assertPublicUrl` runs at send time (not just save time) because DNS can be
 * re-pointed at a private address after the callback URL was saved.
 */
export const postSignedEnvelope = async (args: {
  callbackUrl: string
  signingSecret: string
  envelope: unknown
}): Promise<DeliveryResponse | null> => {
  await assertPublicUrl(args.callbackUrl, "API channel callback URL")

  const rawBody = JSON.stringify(args.envelope)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = await signApiPayload(args.signingSecret, timestamp, rawBody)

  // Pinned at connect and re-checked on every redirect hop: ky followed a
  // 307/308 and re-POSTed the signed body to a host nobody checked (s216).
  const response = await outboundFetch(
    args.callbackUrl,
    {
      method: "POST",
      body: rawBody,
      headers: {
        "Content-Type": "application/json",
        "X-ChatbotX-Signature": `sha256=${signature}`,
        "X-ChatbotX-Timestamp": timestamp,
        "X-ChatbotX-Delivery": crypto.randomUUID(),
      },
    },
    { timeoutMs: DELIVERY_TIMEOUT_MS },
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new DeliveryHttpError(response.status, args.callbackUrl)
  }

  const text = await response.text()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as DeliveryResponse
  } catch {
    return null
  }
}
