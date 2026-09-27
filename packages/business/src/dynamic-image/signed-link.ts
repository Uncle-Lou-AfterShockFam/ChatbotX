import { keys } from "../keys"

/** The public trigger route a Dynamic Image link points at. */
export const DYNAMIC_IMAGE_ROUTE_PATH = "/dynamic-images"

/**
 * The origins our own Dynamic Image trigger URLs can carry: the tenant's app
 * URL, the builder and the OAuth broker (the builder builds the template on
 * the broker origin). A token is only ever appended to a URL on one of these,
 * so a lookalike link to another host never receives a contact's token.
 */
export function dynamicImageLinkOrigins(appUrl: string): string[] {
  const { NEXT_PUBLIC_BUILDER_URL, NEXT_PUBLIC_BROKER_URL } = keys()
  const origins = new Set<string>()
  for (const candidate of [
    appUrl,
    NEXT_PUBLIC_BUILDER_URL,
    NEXT_PUBLIC_BROKER_URL,
  ]) {
    if (!candidate) {
      continue
    }
    try {
      origins.add(new URL(candidate).origin)
    } catch {
      // A malformed tenant URL simply contributes no origin.
    }
  }
  return [...origins]
}

/**
 * Rewrites one of our Dynamic Image trigger URLs to its signed form (s214):
 * drops any `userId` (the old, forgeable identity) and any stale `t`, then
 * appends `t=<token>` minted for its `dynamicImageId`. Any other URL, or one
 * without a `dynamicImageId`, comes back unchanged.
 */
export async function signDynamicImageUrl(
  url: string,
  input: {
    origins: readonly string[]
    sign: (dynamicImageId: string) => Promise<string>
  },
): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (
    !input.origins.includes(parsed.origin) ||
    parsed.pathname !== DYNAMIC_IMAGE_ROUTE_PATH
  ) {
    return url
  }
  const dynamicImageId = parsed.searchParams.get("dynamicImageId")
  if (!dynamicImageId) {
    return url
  }
  parsed.searchParams.delete("userId")
  parsed.searchParams.delete("t")
  parsed.searchParams.set("t", await input.sign(dynamicImageId))
  return parsed.toString()
}

type ImageRef = { url?: string | null }
type SignableStep = {
  url?: unknown
  images?: unknown
  cards?: unknown
}

const signRef = async <T extends ImageRef>(
  ref: T,
  sign: (url: string) => Promise<string>,
): Promise<T> =>
  typeof ref.url === "string" ? { ...ref, url: await sign(ref.url) } : ref

/**
 * Signs every Dynamic Image URL in a resolved flow step: `url` (sendImage),
 * `images[].url` (sendMultipleImages) and `cards[].image.url` (cards and
 * carousels). Everything else in the step is returned as is.
 */
export async function signDynamicImageLinksInStep<T extends object>(
  flowStep: T,
  input: {
    origins: readonly string[]
    sign: (dynamicImageId: string) => Promise<string>
  },
): Promise<T> {
  const signUrl = (url: string) => signDynamicImageUrl(url, input)
  const step = flowStep as SignableStep
  let next: SignableStep = step
  if (typeof step.url === "string") {
    next = { ...next, url: await signUrl(step.url) }
  }
  if (Array.isArray(step.images)) {
    next = {
      ...next,
      images: await Promise.all(
        step.images.map((image: unknown) =>
          image && typeof image === "object"
            ? signRef(image as ImageRef, signUrl)
            : image,
        ),
      ),
    }
  }
  if (Array.isArray(step.cards)) {
    next = {
      ...next,
      cards: await Promise.all(
        step.cards.map(async (card: unknown) => {
          if (!(card && typeof card === "object" && "image" in card)) {
            return card
          }
          const image = (card as { image?: unknown }).image
          if (!(image && typeof image === "object")) {
            return card
          }
          return { ...card, image: await signRef(image as ImageRef, signUrl) }
        }),
      ),
    }
  }
  return next as T
}
