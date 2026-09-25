import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@chatbotx.io/ui/components/ui/alert"
import { formatDate } from "@chatbotx.io/ui/lib/format"
import { ShieldCheckIcon } from "lucide-react"
import { getLocale, getTimeZone, getTranslations } from "next-intl/server"

export async function SupportAccessBanner({
  supportAccessUntil,
}: {
  supportAccessUntil: Date
}) {
  const [t, locale, timeZone] = await Promise.all([
    getTranslations("workspace.supportAccess"),
    getLocale(),
    getTimeZone(),
  ])
  const time = formatDate(supportAccessUntil, {
    hour: "numeric",
    minute: "numeric",
    locale,
    timeZone,
  })

  return (
    <Alert variant="default">
      <ShieldCheckIcon />
      <AlertTitle>{t("bannerTitle")}</AlertTitle>
      <AlertDescription>{t("bannerDescription", { time })}</AlertDescription>
    </Alert>
  )
}
