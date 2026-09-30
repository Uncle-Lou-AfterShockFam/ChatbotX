"use client"

import type { ChannelType } from "@chatbotx.io/database/partials"
import type { InboxModel } from "@chatbotx.io/database/types"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card } from "@chatbotx.io/ui/components/ui/card"
import { useTranslations } from "next-intl"
import { InboxIcon } from "@/features/inboxes/components/inbox-icon"

/** Only what the page renders: the public QR page never gets a full row. */
export type LandingInbox = Pick<InboxModel, "id" | "name" | "channel">

type InboxLink = {
  inbox: LandingInbox
  url: string
}

export function InboxListLandingPage({
  inboxLinks,
}: {
  inboxLinks: InboxLink[]
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-4">
        {inboxLinks.map(({ inbox, url }) => (
          <Card className="flex flex-col px-6 py-2" key={inbox.id}>
            <QrLandingInboxItem inbox={inbox} url={url} />
          </Card>
        ))}
      </div>
    </div>
  )
}

function QrLandingInboxItem({
  inbox,
  url,
}: {
  inbox: LandingInbox
  url: string
}) {
  const t = useTranslations()

  const handleContinue = () => {
    window.open(url, "_blank", "noopener,noreferrer")
  }

  return (
    <div className="flex w-full items-center gap-3 border-t py-4 first:border-t-0">
      <div className="min-w-0 flex-1">
        <InboxIcon
          channel={inbox.channel as ChannelType}
          label={inbox.name}
          size="xlarge"
          wrapperClassName="gap-4"
        />
      </div>

      <Button onClick={handleContinue} size="lg">
        {t("actions.continue")}
      </Button>
    </div>
  )
}
