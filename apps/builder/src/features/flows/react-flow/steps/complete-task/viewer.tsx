"use client"

import { CheckCheckIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const CompleteTaskStepViewer = () => {
  const t = useTranslations()
  return (
    <BaseStepViewer
      icon={CheckCheckIcon}
      title={t("flows.actions.completeTask")}
    />
  )
}

export default CompleteTaskStepViewer
