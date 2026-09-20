/**
 * Whether a request to a tracked link is a link-preview fetch rather than a
 * person tapping it. iMessage, Slack, Facebook and friends fetch every URL
 * they display (iMessage identifies as `facebookexternalhit/1.1 Facebot
 * Twitterbot/1.0`), and counting those would tag every recipient as having
 * clicked. Heuristic: known preview/bot agents, non-navigation fetch
 * metadata, or a non-GET method. A new bot that matches none of these is
 * counted as a click until it is added here; `prefetchCount` keeps the raw
 * evidence either way.
 */
const PREVIEW_AGENT_PATTERN =
  /facebookexternalhit|facebot|twitterbot|whatsapp|slackbot|slack-imgproxy|linkedinbot|discordbot|telegrambot|applebot|googlebot|bingbot|yandex|duckduckbot|baiduspider|pinterest|skypeuripreview|viber|line\/|snapchat|imessagelinkpreview|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|java\/|libwww|headlesschrome|phantomjs|preview|bot\b|crawler|spider/i

const PREFETCH_PURPOSE_PATTERN = /prefetch|preview/i

export const isPreviewUserAgent = (userAgent: string | null): boolean =>
  userAgent === null ||
  userAgent === "" ||
  PREVIEW_AGENT_PATTERN.test(userAgent)

export const isLinkPrefetch = (request: Request): boolean => {
  if (request.method !== "GET") {
    return true
  }
  const dest = request.headers.get("sec-fetch-dest")
  if (dest !== null && dest !== "document") {
    return true
  }
  const mode = request.headers.get("sec-fetch-mode")
  if (mode !== null && mode !== "navigate") {
    return true
  }
  const purpose =
    request.headers.get("purpose") ?? request.headers.get("x-purpose")
  if (purpose !== null && PREFETCH_PURPOSE_PATTERN.test(purpose)) {
    return true
  }
  return isPreviewUserAgent(request.headers.get("user-agent"))
}
