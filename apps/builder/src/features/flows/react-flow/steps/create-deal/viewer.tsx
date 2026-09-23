"use client"

import { HandshakeIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { BaseStepViewer } from "../base/viewer"

const CreateDealStepViewer = () => {
  const t = useTranslations()
  return (
    <BaseStepViewer
      icon={HandshakeIcon}
      title={t("flows.actions.createDeal")}
    />
  )
}

export default CreateDealStepViewer
