"use client"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@chatbotx.io/ui/components/ui/alert"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { TriangleAlertIcon } from "lucide-react"
import { useTranslations } from "next-intl"

/**
 * Shown when a contact filter could not be read (a broken `?contactFilter=`
 * link, a stored filter that no longer parses). The surface behind it must act
 * on NO contact: an invalid filter never widens to everyone (s206).
 */
export function InvalidContactFilterAlert({
  description,
  onClear,
}: {
  description: string
  onClear?: () => void
}) {
  const t = useTranslations()

  return (
    <Alert data-testid="invalid-contact-filter" variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>{t("contacts.invalidFilterTitle")}</AlertTitle>
      <AlertDescription>
        <p>{description}</p>
        {onClear && (
          <Button onClick={onClear} size="sm" type="button" variant="outline">
            {t("contacts.clearInvalidFilter")}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
