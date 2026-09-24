"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { useQuery } from "@tanstack/react-query"
import { ExternalLinkIcon } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { useState } from "react"
import { useCompanySelectOptions } from "@/features/companies/provider/company-hook"
import { ContactSheet } from "@/features/contacts/contact-sheet"
import { orpc } from "@/lib/orpc/query"
import { NONE } from "../deal-field-input"
import { useContactSearchOptions } from "../provider/deal-hook"
import type { DealResource } from "../schema/resource"

type Patch = { contactId?: string | null; companyId?: string | null }

/**
 * The deal's contact and company, by NAME (s195): the contact opens in a
 * stacked sheet, the company on its page; both can be re-linked or cleared.
 */
export function DealLinksSection({
  workspaceId,
  deal,
  onUpdate,
}: {
  workspaceId: string
  deal: DealResource
  onUpdate: (patch: Patch) => void
}) {
  const t = useTranslations()
  const [openContact, setOpenContact] = useState(false)
  const [changingContact, setChangingContact] = useState(false)
  const [keyword, setKeyword] = useState("")
  const contact = useQuery(
    orpc.contactsAPIs.getContactAuthenticatedAPI.queryOptions({
      input: { workspaceId, contactId: deal.contactId ?? "" },
      enabled: Boolean(deal.contactId),
    }),
  )
  const contactName =
    contact.data?.fullName ||
    contact.data?.email ||
    contact.data?.phoneNumber ||
    (deal.contactId ?? "")
  const contactOptions = useContactSearchOptions(workspaceId, keyword, {
    enabled: changingContact && keyword.trim().length > 0,
  })
  const companyOptions = useCompanySelectOptions()
  const companyItems = [
    { value: NONE, label: t("crm.noCompany") },
    ...companyOptions.map((o) => ({ value: o.value, label: o.label })),
  ]
  const companyName =
    companyOptions.find((o) => o.value === deal.companyId)?.label ??
    deal.companyId ??
    ""

  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2" data-testid="deal-links">
      <div className="min-w-0 space-y-1">
        <div className="text-muted-foreground text-xs">
          {t("deals.fields.contact")}
        </div>
        {deal.contactId ? (
          <div className="flex items-center gap-1">
            <button
              className="truncate text-start hover:underline"
              data-testid="deal-contact-link"
              onClick={() => setOpenContact(true)}
              type="button"
            >
              {contactName}
            </button>
            <Button
              aria-label={t("deals.openContact")}
              render={
                <Link
                  href={`/space/${workspaceId}/contacts/${deal.contactId}`}
                />
              }
              size="icon"
              variant="ghost"
            >
              <ExternalLinkIcon className="size-3" />
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">{t("deals.noContact")}</span>
        )}
        {changingContact ? (
          <div className="space-y-1">
            <Input
              aria-label={t("deals.searchContacts")}
              data-testid="deal-contact-search"
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("deals.searchContacts")}
              value={keyword}
            />
            {keyword.trim().length > 0 ? (
              <ul className="max-h-40 divide-y overflow-y-auto">
                {contactOptions.map((o) => (
                  <li key={o.value}>
                    <button
                      className="w-full truncate py-1 text-start hover:underline"
                      onClick={() => {
                        onUpdate({ contactId: o.value })
                        setChangingContact(false)
                        setKeyword("")
                      }}
                      type="button"
                    >
                      {o.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2">
              {deal.contactId ? (
                <Button
                  onClick={() => {
                    onUpdate({ contactId: null })
                    setChangingContact(false)
                  }}
                  size="sm"
                  variant="ghost"
                >
                  {t("deals.noContact")}
                </Button>
              ) : null}
              <Button
                onClick={() => setChangingContact(false)}
                size="sm"
                variant="ghost"
              >
                {t("actions.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button
            data-testid="deal-change-contact"
            onClick={() => setChangingContact(true)}
            size="sm"
            variant="outline"
          >
            {t("crm.changeContact")}
          </Button>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <div className="text-muted-foreground text-xs">
          {t("companies.one")}
        </div>
        {deal.companyId ? (
          <Link
            className="block truncate hover:underline"
            data-testid="deal-company-link"
            href={`/space/${workspaceId}/companies/${deal.companyId}`}
          >
            {companyName}
          </Link>
        ) : (
          <span className="text-muted-foreground">{t("crm.noCompany")}</span>
        )}
        {/* base-ui renders the raw value unless the root gets `items` (s194) */}
        <Select
          items={companyItems}
          onValueChange={(next) => {
            const value = typeof next === "string" ? next : NONE
            const companyId = value === NONE ? null : value
            if (companyId !== deal.companyId) {
              onUpdate({ companyId })
            }
          }}
          value={deal.companyId ?? NONE}
        >
          <SelectTrigger
            aria-label={t("crm.changeCompany")}
            data-testid="deal-company"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {companyItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <ContactSheet
        contactId={openContact ? deal.contactId : null}
        onOpenChange={(open) => {
          if (!open) {
            setOpenContact(false)
          }
        }}
        workspaceId={workspaceId}
      />
    </div>
  )
}
