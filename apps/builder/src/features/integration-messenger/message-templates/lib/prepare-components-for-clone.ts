import "server-only"
import { resumableUploadImage } from "@chatbotx.io/integration-messenger/apis/upload"
import type { MessengerAuthValue } from "@chatbotx.io/integration-messenger/schema"

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

function isMetaImageUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname
    return (
      hostname === "facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname.endsWith(".fbcdn.net") ||
      hostname.endsWith(".fbsbx.com")
    )
  } catch {
    return false
  }
}

function stripLegacyInternalHeaderImageUrl(
  // biome-ignore lint/suspicious/noExplicitAny: Meta component example shape varies
  example: any,
) {
  if (!example || typeof example !== "object") {
    return example
  }

  const { header_image_url: _headerImageUrl, ...rest } = example
  return rest
}

function getStoredHeaderImageUrl(
  // biome-ignore lint/suspicious/noExplicitAny: Meta component shape varies
  component: any,
): string | undefined {
  const headerHandle: string | undefined = component.example?.header_handle?.[0]
  if (headerHandle && isHttpUrl(headerHandle)) {
    return headerHandle
  }

  const legacyInternalImageUrl: string | undefined =
    component.example?.header_image_url
  if (legacyInternalImageUrl && isHttpUrl(legacyInternalImageUrl)) {
    return legacyInternalImageUrl
  }

  return
}

function withHeaderHandle(
  // biome-ignore lint/suspicious/noExplicitAny: Meta component shape varies
  component: any,
  headerHandle: string,
) {
  return {
    ...component,
    example: {
      ...stripLegacyInternalHeaderImageUrl(component.example),
      header_handle: [headerHandle],
    },
  }
}

// IMAGE header handles are page-scoped. The DB stores Meta's listed image URL in
// example.header_handle[0], while the create-template request needs a freshly
// uploaded handle for each target Page.
export async function prepareComponentsForClone(
  // biome-ignore lint/suspicious/noExplicitAny: Meta API component shape varies
  components: any[],
  auth: MessengerAuthValue,
  // biome-ignore lint/suspicious/noExplicitAny: Meta API component shape varies
): Promise<any[]> {
  return await Promise.all(
    // biome-ignore lint/suspicious/noExplicitAny: Meta API component shape varies
    components.map(async (c: any) => {
      if (
        c.type?.toUpperCase() !== "HEADER" ||
        c.format?.toUpperCase() !== "IMAGE"
      ) {
        return c
      }
      const storedHeaderImageUrl = getStoredHeaderImageUrl(c)

      if (!storedHeaderImageUrl) {
        throw new Error(
          "Image header cannot be cloned because Meta returned a page-owned file handle instead of a downloadable image URL. Recreate the template on the target channel with the original image.",
        )
      }

      const newHandle = await resumableUploadImage(auth, storedHeaderImageUrl, {
        authenticatedDownload: isMetaImageUrl(storedHeaderImageUrl),
      })

      return withHeaderHandle(c, newHandle)
    }),
  )
}
