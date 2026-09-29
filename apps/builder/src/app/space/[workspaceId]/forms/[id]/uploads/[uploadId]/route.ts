import { Readable } from "node:stream"
import { formUploadService } from "@chatbotx.io/business/form"
import { uploader } from "@chatbotx.io/filesystem"
import { canAccessContactsSection } from "@/features/contacts/permissions"
import { withWorkspaceIdAndIdSchema } from "@/features/workspaces/schema/resource"
import { getCurrentUserAndTargetWorkspace } from "@/lib/auth/utils"
import { logger } from "@/lib/log"

export const runtime = "nodejs"

/**
 * A submitted web form upload (s225a A2-4 PR 5), for workspace members who
 * may open the contacts section (the forms area's own gate): streamed from
 * private storage, never redirected (the store is docker-internal on
 * netcup). Only a CLAIMED upload of this workspace's form is served; any
 * other request is a bare 404, so an id cannot be probed. Always a download
 * (`attachment`), typed by the sniffed MIME, `nosniff` and a sandbox CSP,
 * so even a crafted file never renders as a page on the hub's origin.
 */
type RouteContext = {
  params: Promise<{ workspaceId: string; id: string; uploadId: string }>
}

const notFound = () => new Response(null, { status: 404 })

const NON_FILENAME_CHARS = /[^\w.-]+/g
const LEADING_DOTS = /^[_.]+/
// RFC 5987 attr-chars: encodeURIComponent leaves ' ( ) * ! unescaped
const RFC5987_UNSAFE = /['()*!]/g

/** `attachment` with an ASCII fallback name plus the RFC 5987 UTF-8 one. */
export const uploadContentDisposition = (fileName: string): string => {
  const ascii =
    fileName
      .normalize("NFKD")
      .replace(NON_FILENAME_CHARS, "_")
      .replace(LEADING_DOTS, "")
      .slice(0, 120) || "upload"
  const utf8 = encodeURIComponent(fileName).replace(
    RFC5987_UNSAFE,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`
}

export async function GET(_request: Request, context: RouteContext) {
  const params = await context.params
  const { data } = withWorkspaceIdAndIdSchema.safeParse({
    workspaceId: params.workspaceId,
    id: params.id,
  })
  if (!data) {
    return notFound()
  }
  const member = await getCurrentUserAndTargetWorkspace(data.workspaceId)
  if (
    !(
      member &&
      canAccessContactsSection(member.targetWorkspaceMember.permissions)
    )
  ) {
    return notFound()
  }
  const upload = await formUploadService.findClaimed({
    workspaceId: data.workspaceId,
    formId: data.id,
    uploadId: params.uploadId,
  })
  if (!upload) {
    return notFound()
  }
  let body: ReadableStream
  try {
    const { stream } = await uploader.getObjectStream(upload.path)
    body = Readable.toWeb(stream) as ReadableStream
  } catch (error) {
    logger.error(
      { err: error, formId: upload.formId, uploadRowId: upload.id },
      "form upload download: object missing",
    )
    return notFound()
  }
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": upload.mimeType,
      "Content-Length": String(upload.sizeBytes),
      "Content-Disposition": uploadContentDisposition(upload.fileName),
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  })
}
