"use client"

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@chatbotx.io/ui/components/ui/sheet"
import { useTranslations } from "next-intl"
import { parseAsString, useQueryStates } from "nuqs"
import { useEffect, useState } from "react"
import { ContactView } from "./contact-view"

/** A stacked contact sheet (s195): opens over deals / companies / contacts pages. */
export function ContactSheet({
  workspaceId,
  contactId,
  onOpenChange,
}: {
  workspaceId: string
  contactId: string | null
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations()
  return (
    <Sheet onOpenChange={onOpenChange} open={contactId !== null}>
      <SheetContent
        className="w-full overflow-y-auto px-4 pb-6 sm:max-w-2xl"
        data-testid="contact-sheet"
      >
        <SheetHeader className="px-0">
          <SheetTitle>{t("fields.contact.label")}</SheetTitle>
          <SheetDescription />
        </SheetHeader>
        {contactId ? (
          <ContactView
            compact
            contactId={contactId}
            workspaceId={workspaceId}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

/**
 * `?contactId=` opens the sheet once, then local state owns it (the deals
 * board's `?dealId=` pattern, s194).
 */
export function ContactSheetFromQuery({
  workspaceId,
}: {
  workspaceId: string
}) {
  const [{ contactId: queryContactId }, setQuery] = useQueryStates({
    contactId: parseAsString,
  })
  const [contactId, setContactId] = useState<string | null>(queryContactId)
  useEffect(() => {
    if (queryContactId) {
      setContactId(queryContactId)
      setQuery({ contactId: null })
    }
  }, [queryContactId, setQuery])
  return (
    <ContactSheet
      contactId={contactId}
      onOpenChange={(open) => {
        if (!open) {
          setContactId(null)
        }
      }}
      workspaceId={workspaceId}
    />
  )
}
