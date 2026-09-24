"use client"

import { KanbanIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepEditor } from "../base/editor"
import { PipelinePicker, StagePicker } from "../deal-pickers"

const MoveDealStageStepEditor = ({ parentName }: { parentName: string }) => {
  const t = useTranslations()
  return (
    <BaseStepEditor icon={KanbanIcon} title={t("flows.actions.moveDealStage")}>
      <div className="mt-3 space-y-3">
        <PipelinePicker parentName={parentName} />
        <StagePicker parentName={parentName} />
      </div>
    </BaseStepEditor>
  )
}

export default MoveDealStageStepEditor
