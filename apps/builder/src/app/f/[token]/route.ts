import { documentService } from "@chatbotx.io/business/documents"
import { uploader } from "@chatbotx.io/filesystem"
import { NextResponse } from "next/server"
import { logger } from "@/lib/log"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

/**
 * Public download of a document generated for a contact (roadmap B3):
 * `/f/<token>`, texted or emailed to the person. The 22-character token
 * (128 random bits) is the only credential and expires with the row. The PDF
 * is STREAMED from private storage, never redirected: the object store is
 * docker-internal on netcup, and a presigned URL would leak its host.
 * Nothing is recorded, so a link-preview fetch has no side effect.
 */
type RouteContext = { params: Promise<{ token: string }> }

const notFound = () => NextResponse.json({ code: "notFound" }, { status: 404 })

/** A filename safe for Content-Disposition (ASCII word characters only). */
export const documentFileName = (title: string): string => {
  const base = title
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80)
  return `${base || "document"}.pdf`
}

export async function GET(_request: Request, context: RouteContext) {
  const { token } = await context.params
  const found = await documentService.resolveDownload({ token })
  if (!found.ok) {
    return found.reason === "expired"
      ? NextResponse.json({ code: "linkExpired" }, { status: 410 })
      : notFound()
  }
  const { servable } = await loadServableWorkspace(found.document.workspaceId)
  if (!servable) {
    return NextResponse.json({ code: "workspaceScheduledDeletion" }, { status: 410 })
  }
  let pdf: Buffer
  try {
    pdf = await uploader.getObject(found.path)
  } catch (error) {
    logger.error(error, `document file missing for token ${token.slice(0, 4)}...`)
    return notFound()
  }
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Content-Disposition": `inline; filename="${documentFileName(found.document.title)}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  })
}
