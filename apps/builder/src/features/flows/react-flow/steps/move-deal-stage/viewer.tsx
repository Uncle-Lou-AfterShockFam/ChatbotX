"use client"

import { KanbanIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const MoveDealStageStepViewer = () => {
  const t = useTranslations()
  return (
    <BaseStepViewer
      icon={KanbanIcon}
      title={t("flows.actions.moveDealStage")}
    />
  )
}

export default MoveDealStageStepViewer
