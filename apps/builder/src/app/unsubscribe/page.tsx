import type { Metadata } from "next"
import { getTranslations } from "next-intl/server"
import { checkUnsubscribeToken } from "@/lib/unsubscribe/unsubscribe-by-token"

export const metadata: Metadata = {
  title: "Unsubscribe",
}

type UnsubscribePageProps = {
  searchParams: Promise<{ token?: string; result?: string }>
}

/**
 * Viewing this page never unsubscribes: link scanners (Safe Links, mailbox
 * prefetch) GET every URL in a mail. The confirm button POSTs to
 * /unsubscribe/one-click, which redirects back with `result`.
 */
export default async function UnsubscribePage(props: UnsubscribePageProps) {
  const { token, result } = await props.searchParams
  const t = await getTranslations("unsubscribePage")

  // `result` is only a hint from the POST redirect: the token is always
  // verified, and "done" shows only for a contact that IS opted out.
  const checked = await checkUnsubscribeToken(token)

  if (checked.status === "unavailable") {
    return (
      <UnsubscribeMessage
        description={t("unavailableDescription")}
        title={t("unavailableTitle")}
      />
    )
  }
  if (checked.status !== "valid" || !token) {
    return (
      <UnsubscribeMessage
        description={t("invalidDescription")}
        title={t("invalidTitle")}
      />
    )
  }
  if (result === "done" && checked.emailOptIn === false) {
    return (
      <UnsubscribeMessage description={t("description")} title={t("title")} />
    )
  }

  return (
    <UnsubscribeMessage
      description={t("confirmDescription")}
      title={t("confirmTitle")}
    >
      <form
        action={`/unsubscribe/one-click?token=${encodeURIComponent(token)}`}
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
    </UnsubscribeMessage>
  )
}

function UnsubscribeMessage({
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
