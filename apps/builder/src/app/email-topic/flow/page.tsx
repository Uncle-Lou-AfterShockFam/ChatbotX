import type { Metadata } from "next"
import { getTranslations } from "next-intl/server"
import { checkEmailFlowToken } from "@/lib/email-flow/start-by-token"

export const metadata: Metadata = {
  title: "Continue",
  // The token is in the URL: never send it on as a Referer.
  referrer: "no-referrer",
}

type EmailFlowPageProps = {
  searchParams: Promise<{ t?: string; r?: string }>
}

/**
 * B2 phase 4 (s222b): a newsletter button that starts a flow. Viewing this
 * page never starts it: link scanners (Safe Links, mailbox prefetch) GET every
 * URL in a mail. The button POSTs to /email-topic/flow/start, which redirects
 * back with `result`.
 */
export default async function EmailFlowPage(props: EmailFlowPageProps) {
  const { t: token, r: recipient } = await props.searchParams
  const t = await getTranslations("emailFlowPage")
  const checked = await checkEmailFlowToken(token)

  if (checked.status === "unavailable") {
    return (
      <EmailFlowMessage
        description={t("unavailableDescription")}
        title={t("unavailableTitle")}
      />
    )
  }
  if (checked.status !== "valid" || !token) {
    return (
      <EmailFlowMessage
        description={t("invalidDescription")}
        title={t("invalidTitle")}
      />
    )
  }
  // Whatever `result` says, "started" shows exactly when the link's claim
  // exists (a click is starting or has started it), so a reopened mail never
  // offers a second start.
  if (checked.started) {
    return (
      <EmailFlowMessage
        description={t("startedDescription")}
        title={t("startedTitle")}
      />
    )
  }

  const query = new URLSearchParams({ t: token })
  if (recipient) {
    query.set("r", recipient)
  }
  return (
    <EmailFlowMessage
      description={t("confirmDescription")}
      title={t("confirmTitle")}
    >
      <form
        action={`/email-topic/flow/start?${query.toString()}`}
        method="post"
      >
        <input name="source" type="hidden" value="page" />
        <button
          className="mt-4 rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground text-sm"
          type="submit"
        >
          {t("confirmButton")}
        </button>
      </form>
    </EmailFlowMessage>
  )
}

function EmailFlowMessage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-screen w-screen items-center justify-center px-4">
      <div className="max-w-sm text-center">
        <h1 className="font-semibold text-xl">{title}</h1>
        <p className="mt-2 text-muted-foreground">{description}</p>
        {children}
      </div>
    </div>
  )
}
