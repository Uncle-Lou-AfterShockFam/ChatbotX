import { NextResponse } from "next/server"
import { unsubscribeByToken } from "@/lib/unsubscribe/unsubscribe-by-token"

/**
 * RFC 8058 one-click unsubscribe (s220b). A mail client POSTs
 * `List-Unsubscribe=One-Click` to the URL in the List-Unsubscribe header and
 * gets a bare status. The /unsubscribe confirm form posts here too, with
 * `source=page`, and is redirected back to the page's result view.
 *
 * Only POST acts: link scanners GET every URL in a mail, so a GET that
 * unsubscribed would opt people out unasked.
 */
export async function POST(request: Request) {
  const url = new URL(request.url)
  const token = url.searchParams.get("token")

  let fromPage = false
  let oneClick = false
  try {
    const form = await request.formData()
    fromPage = form.get("source") === "page"
    oneClick = form.get("List-Unsubscribe") === "One-Click"
  } catch {
    // Not a form body: refused below.
  }

  if (!(fromPage || oneClick)) {
    return new NextResponse(null, { status: 400 })
  }

  const status = await unsubscribeByToken(token)

  if (fromPage) {
    const back = new URL("/unsubscribe", url.origin)
    back.searchParams.set("token", token ?? "")
    back.searchParams.set("result", status === "valid" ? "done" : status)
    return NextResponse.redirect(back, { status: 303 })
  }

  if (status === "invalid") {
    return new NextResponse(null, { status: 400 })
  }
  if (status === "unavailable") {
    return new NextResponse(null, { status: 410 })
  }
  return new NextResponse(null, { status: 200 })
}
