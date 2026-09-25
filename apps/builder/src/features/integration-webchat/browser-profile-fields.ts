export const getWebchatProfileFields = (): {
  locale?: string
  parentUrl?: string
  timezone?: string
} => {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return {}
  }

  return {
    locale: navigator.language || undefined,
    parentUrl: getWebchatParentUrl(),
    // zone: viewer (the webchat visitor's own browser zone)
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
  }
}

const getWebchatParentUrl = (): string | undefined => {
  const queryParentUrl = getQueryParentUrl()
  if (queryParentUrl) {
    return queryParentUrl
  }

  return document.referrer || window.location.ancestorOrigins?.[0]
}

const getQueryParentUrl = (): string | undefined => {
  const parentUrl = new URLSearchParams(window.location.search).get("parentUrl")
  if (!parentUrl) {
    return
  }

  try {
    return new URL(parentUrl).toString()
  } catch {
    return
  }
}
