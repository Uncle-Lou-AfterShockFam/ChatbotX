"use client"

import { TrophyIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const SetDealStatusStepViewer = () => {
  const t = useTranslations()
  return (
    <BaseStepViewer
      icon={TrophyIcon}
      title={t("flows.actions.setDealStatus")}
    />
  )
}

export default SetDealStatusStepViewer
