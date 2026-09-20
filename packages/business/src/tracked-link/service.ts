import { and, db, eq, sql } from "@chatbotx.io/database/client"
import type { TrackedLinkModel } from "@chatbotx.io/database/schema"
import { trackedLinkModel } from "@chatbotx.io/database/schema"
import { BaseService } from "../base.service"

/** Base62 alphabet: URL-safe with no escaping, no look-alike separators. */
const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
/** 11 base62 characters carry 65 bits, so 8 random bytes fit with margin. */
export const TRACKED_LINK_TOKEN_LENGTH = 11
/**
 * Path segment the public redirect route lives under
 * (`apps/builder/src/app/go/[token]`). Not `/l`: that prefix already holds the
 * QR landing page `/l/[workspaceId]/[id]`, and Next.js refuses two different
 * slug names at one path level (it crash-looped the builder, s165).
 */
export const TRACKED_LINK_PATH = "/go"
/** Suffix under a pixel token: `/go/<token>/o` answers a 1x1 GIF. */
export const TRACKED_PIXEL_SUFFIX = "/o"
/** Longest destination a text may carry; matches the flow step's text bound. */
export const MAX_TRACKED_LINK_URL_LENGTH = 2048

export type TrackedLinkVisitKind = "click" | "prefetch"

export const isTrackedLinkToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length === TRACKED_LINK_TOKEN_LENGTH &&
  [...value].every((ch) => ALPHABET.includes(ch))

/**
 * 64 random bits rendered in base62. Not `createId()`: a snowflake is
 * sequential and guessable, and a guessable token would let anyone mark a
 * contact as having clicked.
 */
/** Web Crypto, not `node:crypto`: the business barrel must stay Edge-Runtime safe. */
const webRandomBytes = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n))

export const mintTrackedLinkToken = (
  random: (bytes: number) => Uint8Array = webRandomBytes,
): string => {
  const bytes = random(8)
  let value = 0n
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte)
  }
  let out = ""
  for (let i = 0; i < TRACKED_LINK_TOKEN_LENGTH; i++) {
    out = ALPHABET[Number(value % 62n)] + out
    value /= 62n
  }
  return out
}

const TRAILING_SLASHES = /\/+$/
const HTTP_URL = /^https?:\/\/\S+$/

export const buildTrackedLinkUrl = (appUrl: string, token: string): string =>
  `${appUrl.replace(TRAILING_SLASHES, "")}${TRACKED_LINK_PATH}/${token}`

export const buildTrackedPixelUrl = (appUrl: string, token: string): string =>
  `${buildTrackedLinkUrl(appUrl, token)}${TRACKED_PIXEL_SUFFIX}`

class TrackedLinkService extends BaseService {
  /** Mint one short link for one URL in one contact's text; returns the token. */
  async mint(input: {
    workspaceId: string
    contactId: string
    contactInboxId: string | null
    flowId: string | null
    stepId: string | null
    url: string
  }): Promise<string> {
    if (
      typeof input.url !== "string" ||
      input.url.length > MAX_TRACKED_LINK_URL_LENGTH ||
      !HTTP_URL.test(input.url)
    ) {
      throw new TypeError("mint: url must be an http(s) URL")
    }
    const token = mintTrackedLinkToken()
    await db.insert(trackedLinkModel).values({
      token,
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      contactInboxId: input.contactInboxId,
      flowId: input.flowId,
      stepId: input.stepId,
      url: input.url,
    })
    return token
  }

  /**
   * Mint the open beacon of one mail to one contact. The email line renders it
   * as `<img src="${appUrl}/go/<token>/o">`; a fetch of that GIF is an open.
   */
  async mintPixel(input: {
    workspaceId: string
    contactId: string
    contactInboxId: string | null
    flowId: string | null
    stepId: string | null
  }): Promise<string> {
    const token = mintTrackedLinkToken()
    await db.insert(trackedLinkModel).values({
      token,
      kind: "pixel",
      workspaceId: input.workspaceId,
      contactId: input.contactId,
      contactInboxId: input.contactInboxId,
      flowId: input.flowId,
      stepId: input.stepId,
      url: "",
    })
    return token
  }

  /**
   * Record one open of a pixel row (first/last instant, count). Opens are not
   * filtered like clicks: mail clients fetch images through proxies (Gmail's
   * image proxy, Apple Mail privacy prefetch), so every fetch counts and the
   * known false positives are a documented limit, not a heuristic.
   */
  async recordOpen(
    token: string,
    now: Date = new Date(),
  ): Promise<TrackedLinkModel | undefined> {
    if (!isTrackedLinkToken(token)) {
      return
    }
    const [row] = await db
      .update(trackedLinkModel)
      .set({
        openCount: sql`${trackedLinkModel.openCount} + 1`,
        firstOpenedAt: sql`COALESCE(${trackedLinkModel.firstOpenedAt}, ${now})`,
        lastOpenedAt: now,
      })
      .where(
        and(
          eq(trackedLinkModel.token, token),
          eq(trackedLinkModel.kind, "pixel"),
        ),
      )
      .returning()
    return row
  }

  async findByToken(token: string): Promise<TrackedLinkModel | undefined> {
    if (!isTrackedLinkToken(token)) {
      return
    }
    const [row] = await db
      .select()
      .from(trackedLinkModel)
      .where(eq(trackedLinkModel.token, token))
      .limit(1)
    return row
  }

  /**
   * Record one visit in a single UPDATE ... RETURNING. A human-looking visit
   * bumps `clickCount` and the click timestamps; a preview fetch only bumps
   * `prefetchCount`, so the row still shows the link was fetched without
   * counting it as a click.
   */
  async recordVisit(
    token: string,
    kind: TrackedLinkVisitKind,
    now: Date = new Date(),
  ): Promise<TrackedLinkModel | undefined> {
    if (!isTrackedLinkToken(token)) {
      return
    }
    const set =
      kind === "click"
        ? {
            clickCount: sql`${trackedLinkModel.clickCount} + 1`,
            firstClickedAt: sql`COALESCE(${trackedLinkModel.firstClickedAt}, ${now})`,
            lastClickedAt: now,
          }
        : { prefetchCount: sql`${trackedLinkModel.prefetchCount} + 1` }
    const [row] = await db
      .update(trackedLinkModel)
      .set(set)
      .where(eq(trackedLinkModel.token, token))
      .returning()
    return row
  }
}

export const trackedLinkService = new TrackedLinkService()
