"use client"

import type { CompanyModel } from "@chatbotx.io/database/types"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@chatbotx.io/ui/components/ui/card"
import { ArrowLeftIcon, PencilIcon } from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useState } from "react"
import { DeleteCompaniesDialog } from "./delete-company-dialog"
import { StopCompanyDialog } from "./stop-company-dialog"
import { UpdateCompanyDialog } from "./update-company-dialog"

type CompanyContact = {
  id: string
  fullName: string | null
  email: string | null
  phoneNumber: string | null
  createdAt: Date
}

export function CompanyDetail({
  workspaceId,
  company,
  contacts,
}: {
  workspaceId: string
  company: CompanyModel
  contacts: CompanyContact[]
}) {
  const t = useTranslations()
  const format = useFormatter()
  const [editing, setEditing] = useState(false)

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            render={<Link href={`/space/${workspaceId}/companies`} />}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h4 className="font-bold text-xl">{company.name}</h4>
          {company.stoppedAt ? (
            <Badge variant="destructive">{t("companies.stopped")}</Badge>
          ) : (
            <Badge variant="outline">{t("companies.active")}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setEditing(true)} size="sm" variant="outline">
            <PencilIcon className="me-2 size-4" />
            {t("actions.edit")}
          </Button>
          <StopCompanyDialog company={company} workspaceId={workspaceId} />
          <DeleteCompaniesDialog
            companies={[company]}
            workspaceId={workspaceId}
          />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("companies.details")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
          <Field label={t("companies.fields.domains")}>
            {company.domains.length > 0
              ? company.domains.map((domain) => (
                  <Badge className="me-1" key={domain} variant="secondary">
                    {domain}
                  </Badge>
                ))
              : "-"}
          </Field>
          <Field label={t("companies.fields.website")}>
            {company.website ?? "-"}
          </Field>
          <Field label={t("companies.fields.phone")}>
            {company.phone ?? "-"}
          </Field>
          <Field label={t("companies.stopOnReply")}>
            {company.stopOnReply ? t("companies.yes") : t("companies.no")}
          </Field>
          <Field label={t("companies.stoppedAt")}>
            {company.stoppedAt
              ? `${format.dateTime(company.stoppedAt, { dateStyle: "medium", timeStyle: "short" })}${company.stopReason ? ` (${company.stopReason})` : ""}`
              : "-"}
          </Field>
          <Field label={t("companies.fields.notes")}>
            <span className="whitespace-pre-wrap">{company.notes ?? "-"}</span>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("companies.fields.contactCount")}: {contacts.length}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {contacts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("companies.noContacts")}
            </p>
          ) : (
            <ul className="divide-y">
              {contacts.map((contact) => (
                <li
                  className="flex items-center justify-between gap-2 py-2 text-sm"
                  key={contact.id}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {contact.fullName ?? contact.email ?? contact.phoneNumber}
                    </div>
                    <div className="truncate text-muted-foreground text-xs">
                      {[contact.email, contact.phoneNumber]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {format.dateTime(contact.createdAt, {
                      dateStyle: "medium",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <UpdateCompanyDialog
        company={company}
        onOpenChange={setEditing}
        open={editing}
        workspaceId={workspaceId}
      />
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div>{children}</div>
    </div>
  )
}
