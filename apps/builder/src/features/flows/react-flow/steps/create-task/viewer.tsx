"use client"

import { ListChecksIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const CreateTaskStepViewer = () => {
  const t = useTranslations()
  return (
    <BaseStepViewer
      icon={ListChecksIcon}
      title={t("flows.actions.createTask")}
    />
  )
}

export default CreateTaskStepViewer
