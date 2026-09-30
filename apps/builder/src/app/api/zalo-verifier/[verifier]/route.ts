import { escapeHtml } from "@chatbotx.io/business/documents"
import type { NextRequest } from "next/server"
import { NextResponse } from "next/server"

/**
 * Zalo domain verification: `/zalo_verifier<token>.html` (rewritten here by
 * next.config) serves the token in a meta tag. The path is anonymous input,
 * so only a verifier-shaped token is served (s231a: an unescaped attribute
 * was reflected XSS); anything else is a plain 404 that never echoes it.
 */
const VERIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ verifier: string }> },
) {
  const { verifier } = await params

  if (typeof verifier !== "string" || !VERIFIER_PATTERN.test(verifier)) {
    return new NextResponse("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  return new NextResponse(
    `
<!DOCTYPE html>
<html lang="en">

<head>
    <meta property="zalo-platform-site-verification" content="${escapeHtml(verifier)}" />
</head>

<body>
There Is No Limit To What You Can Accomplish Using Zalo!
</body>

</html>
    `,
    { status: 200, headers: PAGE_HEADERS },
  )
}
