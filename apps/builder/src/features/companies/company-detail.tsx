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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  PencilIcon,
  PlusIcon,
  XIcon,
} from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import { onActionError } from "@/features/common/lib/on-action-error"
import { ContactSheet } from "@/features/contacts/contact-sheet"
import { CreateContactForm } from "@/features/contacts/create-contact-form"
import { CompanyNotesPanel } from "@/features/crm/components/company-notes-panel"
import { CrmDealDrawer } from "@/features/crm/components/crm-deal-drawer"
import { DealsList } from "@/features/crm/components/deals-list"
import { NewDealButton } from "@/features/crm/components/new-deal-button"
import { Spinner } from "@/features/crm/components/spinner"
import { SubmissionsList } from "@/features/crm/components/submissions-list"
import { TasksList } from "@/features/crm/components/tasks-list"
import {
  describeCompanyActivity,
  TimelineList,
} from "@/features/crm/components/timeline-list"
import {
  useCompanyActivities,
  useCompanyConversations,
  useCompanyDeals,
  useCompanyMetrics,
  useCompanySubmissions,
  useCompanyTasks,
  useCompanyTimeline,
  useInvalidateCrm,
  usePipelines,
} from "@/features/crm/provider/crm-hooks"
import type { TimelineKind } from "@/features/crm/schema/resource"
import { formatDealValue } from "@/features/deals/deal-card"
import { namesById } from "@/features/deals/lib/names-by-id"
import {
  useContactSearchOptions,
  useOwnerOptions,
} from "@/features/deals/provider/deal-hook"
import { InboxStoreProvider } from "@/features/inboxes/provider/inbox-store-context"
import { SequenceStoreProvider } from "@/features/sequences/provider/sequence-store-context"
import { client } from "@/lib/orpc/orpc"
import { setContactCompanyAction } from "./actions/set-contact-company-action"
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

const COMPANY_KINDS: TimelineKind[] = [
  "companyActivity",
  "companyNote",
  "dealActivity",
  "submission",
  "appointment",
]

/**
 * Company 360 (s195): header metrics, details, then one card per linked
 * record type, each self-fetching with its own empty state. Contacts open in
 * a stacked sheet, deals in the drawer. Files / invoices / projects say so
 * honestly instead of rendering an empty list (polaris `not_built`).
 */
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
  const [openContactId, setOpenContactId] = useState<string | null>(null)
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const metrics = useCompanyMetrics(workspaceId, company.id)
  const deals = useCompanyDeals(workspaceId, company.id)
  const pipelines = usePipelines(workspaceId)
  const ownerOptions = useOwnerOptions(workspaceId)
  const memberNames = useMemo(
    () => new Map(ownerOptions.map((o) => [o.value, o.label])),
    [ownerOptions],
  )
  const stageNames = useMemo(
    () => namesById(pipelines.data ?? []),
    [pipelines.data],
  )
  let lastActivityLabel: string | null = null
  if (metrics.data) {
    lastActivityLabel = metrics.data.lastActivityAt
      ? format.dateTime(new Date(metrics.data.lastActivityAt), {
          dateStyle: "medium",
        })
      : "-"
  }
  /** one exact figure per currency, never folded together (a EUR deal is not USD) */
  const money = (byCurrency: Record<string, string>) => {
    const parts = Object.entries(byCurrency).map(
      ([currency, value]) => formatDealValue(value, currency, format) ?? "",
    )
    return parts.length > 0 ? parts.join(" · ") : "-"
  }

  return (
    <div className="space-y-4" data-testid="company-360">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            render={<Link href={`/space/${workspaceId}/companies`} />}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <h4 className="truncate font-bold text-xl">{company.name}</h4>
          {company.stoppedAt ? (
            <Badge variant="destructive">{t("companies.stopped")}</Badge>
          ) : (
            <Badge variant="outline">{t("companies.active")}</Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7"
        data-testid="company-metrics"
      >
        <Metric
          label={t("crm.metrics.contacts")}
          value={metrics.data ? String(metrics.data.contacts) : null}
        />
        <Metric
          label={t("crm.metrics.openDeals")}
          value={metrics.data ? String(metrics.data.openDeals) : null}
        />
        <Metric
          label={t("crm.metrics.openValue")}
          value={metrics.data ? money(metrics.data.openValue) : null}
        />
        <Metric
          label={t("crm.metrics.wonValue")}
          value={metrics.data ? money(metrics.data.wonValue) : null}
        />
        <Metric
          label={t("crm.metrics.openTasks")}
          value={metrics.data ? String(metrics.data.openTasks) : null}
        />
        <Metric
          label={t("crm.metrics.overdueTasks")}
          value={metrics.data ? String(metrics.data.overdueTasks) : null}
        />
        <Metric
          label={t("crm.metrics.lastActivity")}
          value={lastActivityLabel}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("companies.details")}
            </CardTitle>
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
              <span className="whitespace-pre-wrap">
                {company.notes ?? "-"}
              </span>
            </Field>
          </CardContent>
        </Card>

        <ContactsCard
          companyId={company.id}
          contacts={contacts}
          onOpen={setOpenContactId}
          workspaceId={workspaceId}
        />

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base">{t("crm.tabs.deals")}</CardTitle>
            <NewDealButton
              presetCompanyId={company.id}
              workspaceId={workspaceId}
            />
          </CardHeader>
          <CardContent>
            {deals.isLoading ? (
              <Spinner />
            ) : (
              <DealsList
                deals={deals.data ?? []}
                onOpen={(deal) => setOpenDealId(deal.id)}
                pipelines={pipelines.data ?? []}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("crm.tabs.conversations")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ConversationsCard
              companyId={company.id}
              workspaceId={workspaceId}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("crm.tabs.tasks")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TasksCard
              companyId={company.id}
              deals={deals.data ?? []}
              workspaceId={workspaceId}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("crm.tabs.submissions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <SubmissionsCard companyId={company.id} workspaceId={workspaceId} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("crm.tabs.notes")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CompanyNotesPanel
              companyId={company.id}
              memberNames={memberNames}
              workspaceId={workspaceId}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("crm.tabs.activity")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityCard
              companyId={company.id}
              memberNames={memberNames}
              workspaceId={workspaceId}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("crm.tabs.timeline")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <TimelineCard
              companyId={company.id}
              onOpenDeal={setOpenDealId}
              stageNames={stageNames}
              workspaceId={workspaceId}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2" data-testid="company-not-built">
          <CardHeader>
            <CardTitle className="text-base">
              {t("crm.notBuilt.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-muted-foreground text-sm sm:grid-cols-3">
            <p>{t("crm.notBuilt.files")}</p>
            <p>{t("crm.notBuilt.invoices")}</p>
            <p>{t("crm.notBuilt.projects")}</p>
          </CardContent>
        </Card>
      </div>

      <UpdateCompanyDialog
        company={company}
        onOpenChange={setEditing}
        open={editing}
        workspaceId={workspaceId}
      />
      <ContactSheet
        contactId={openContactId}
        onOpenChange={(open) => {
          if (!open) {
            setOpenContactId(null)
          }
        }}
        workspaceId={workspaceId}
      />
      <SequenceStoreProvider autoInitialize={false} workspaceId={workspaceId}>
        <CrmDealDrawer
          dealId={openDealId}
          onOpenChange={(open) => {
            if (!open) {
              setOpenDealId(null)
            }
          }}
          workspaceId={workspaceId}
        />
      </SequenceStoreProvider>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-md border px-3 py-2" data-testid="company-metric">
      <div className="truncate text-muted-foreground text-xs">{label}</div>
      <div className="truncate font-semibold text-lg">
        {value ?? <Spinner />}
      </div>
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
    <div className="min-w-0">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="break-words">{children}</div>
    </div>
  )
}

/** The company's people: click opens the sheet; link an existing contact by search, create a new one, or unlink. */
function ContactsCard({
  workspaceId,
  companyId,
  contacts,
  onOpen,
}: {
  workspaceId: string
  companyId: string
  contacts: CompanyContact[]
  onOpen: (contactId: string) => void
}) {
  const t = useTranslations()
  const format = useFormatter()
  const invalidate = useInvalidateCrm()
  const [adding, setAdding] = useState(false)
  const [creating, setCreating] = useState(false)
  const [keyword, setKeyword] = useState("")
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const options = useContactSearchOptions(workspaceId, keyword, {
    enabled: adding && keyword.trim().length > 0,
  })
  const linked = new Set(contacts.map((c) => c.id))
  const link = useAction(setContactCompanyAction.bind(null, workspaceId), {
    onSuccess: () => {
      toast.success(t("crm.linked"))
      setAdding(false)
      setKeyword("")
      invalidate()
      // the contacts list is RSC-loaded: refresh the page data
      window.location.reload()
    },
    onError: onActionError,
  })
  const unlink = async (contactId: string) => {
    setUnlinking(contactId)
    try {
      await client.crmAPI.privateUnlinkCompanyContactAPI({
        workspaceId,
        id: companyId,
        contactId,
      })
      toast.success(t("crm.unlinked"))
      await invalidate()
      window.location.reload()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setUnlinking(null)
    }
  }
  return (
    <Card data-testid="company-contacts">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">
          {t("crm.tabs.contacts")}: {contacts.length}
        </CardTitle>
        <div className="flex gap-2">
          <Button
            data-testid="company-add-contact"
            onClick={() => setAdding((v) => !v)}
            size="sm"
            variant="outline"
          >
            <PlusIcon className="me-2 size-4" />
            {t("crm.addContact")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {adding ? (
          <div className="space-y-2 rounded-md border p-3">
            <Input
              aria-label={t("crm.searchContact")}
              data-testid="company-contact-search"
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={t("crm.searchContact")}
              value={keyword}
            />
            {keyword.trim().length > 0 ? (
              <ul className="max-h-48 divide-y overflow-y-auto text-sm">
                {options
                  .filter((o) => !linked.has(o.value))
                  .map((o) => (
                    <li
                      className="flex items-center justify-between gap-2 py-1"
                      key={o.value}
                    >
                      <span className="truncate">{o.label}</span>
                      <Button
                        data-testid="company-link-contact"
                        disabled={link.isPending}
                        onClick={() =>
                          link.execute({ contactId: o.value, companyId })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        {t("crm.linkContact")}
                      </Button>
                    </li>
                  ))}
                {options.filter((o) => !linked.has(o.value)).length === 0 ? (
                  <li className="py-1 text-muted-foreground">
                    {t("actions.noRecordFound")}
                  </li>
                ) : null}
              </ul>
            ) : null}
            <Button
              data-testid="company-create-contact"
              onClick={() => setCreating(true)}
              size="sm"
              variant="ghost"
            >
              {t("crm.createContact")}
            </Button>
          </div>
        ) : null}
        {contacts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("companies.noContacts")}
          </p>
        ) : (
          <ul className="divide-y">
            {contacts.map((contact) => (
              <li
                className="flex items-center justify-between gap-2 py-2 text-sm"
                data-testid="company-contact-row"
                key={contact.id}
              >
                <button
                  className="min-w-0 flex-1 text-start hover:underline"
                  onClick={() => onOpen(contact.id)}
                  type="button"
                >
                  <div className="truncate font-medium">
                    {contact.fullName ?? contact.email ?? contact.phoneNumber}
                  </div>
                  <div className="truncate text-muted-foreground text-xs">
                    {[contact.email, contact.phoneNumber]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </button>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {format.dateTime(contact.createdAt, { dateStyle: "medium" })}
                </span>
                <Button
                  aria-label={t("crm.openPage")}
                  render={
                    <Link
                      href={`/space/${workspaceId}/contacts/${contact.id}`}
                    />
                  }
                  size="icon"
                  variant="ghost"
                >
                  <ExternalLinkIcon className="size-3" />
                </Button>
                <ConfirmButton
                  aria-label={t("crm.unlink")}
                  data-testid="company-unlink-contact"
                  description={t("crm.unlinkConfirm")}
                  disabled={unlinking === contact.id}
                  onConfirm={() => unlink(contact.id)}
                  size="icon"
                  title={t("crm.unlink")}
                  variant="ghost"
                >
                  <XIcon className="size-3" />
                </ConfirmButton>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog onOpenChange={setCreating} open={creating}>
        <DialogContent className="max-h-screen overflow-y-scroll lg:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {t("messages.createFeature", {
                feature: t("fields.contact.label"),
              })}
            </DialogTitle>
            <DialogDescription />
          </DialogHeader>
          <InboxStoreProvider workspaceId={workspaceId}>
            <CreateContactForm
              onCancelled={() => setCreating(false)}
              onSubmmited={(created) => {
                setCreating(false)
                if (created) {
                  link.execute({ contactId: created.id, companyId })
                }
              }}
              workspaceId={workspaceId}
            />
          </InboxStoreProvider>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function ConversationsCard({
  workspaceId,
  companyId,
}: {
  workspaceId: string
  companyId: string
}) {
  const t = useTranslations()
  const format = useFormatter()
  const conversations = useCompanyConversations(workspaceId, companyId)
  if (conversations.isLoading) {
    return <Spinner />
  }
  const rows = conversations.data ?? []
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("crm.noConversations")}
      </p>
    )
  }
  return (
    <ul className="divide-y" data-testid="company-conversations">
      {rows.map((row) => (
        <li
          className="flex items-center justify-between gap-2 py-2 text-sm"
          key={row.id}
        >
          <div className="min-w-0">
            <div className="truncate font-medium">
              {row.contactName ?? t("crm.noContactYet")}
            </div>
            <div className="truncate text-muted-foreground text-xs">
              {row.lastActivityAt
                ? t("crm.lastActivityAt", {
                    date: format.dateTime(new Date(row.lastActivityAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }),
                  })
                : "-"}
            </div>
          </div>
          <Button
            render={
              <Link
                href={`/space/${workspaceId}/inbox?conversationId=${row.id}`}
              />
            }
            size="sm"
            variant="outline"
          >
            <ExternalLinkIcon className="me-2 size-4" />
            {t("crm.openInInbox")}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function TasksCard({
  workspaceId,
  companyId,
  deals,
}: {
  workspaceId: string
  companyId: string
  deals: { id: string; title: string }[]
}) {
  const tasks = useCompanyTasks(workspaceId, companyId)
  const invalidate = useInvalidateCrm()
  if (tasks.isLoading) {
    return <Spinner />
  }
  return (
    <TasksList
      deals={deals}
      onChanged={invalidate}
      tasks={tasks.data ?? []}
      workspaceId={workspaceId}
    />
  )
}

function SubmissionsCard({
  workspaceId,
  companyId,
}: {
  workspaceId: string
  companyId: string
}) {
  const submissions = useCompanySubmissions(workspaceId, companyId)
  if (submissions.isLoading) {
    return <Spinner />
  }
  return (
    <SubmissionsList
      submissions={submissions.data ?? []}
      workspaceId={workspaceId}
    />
  )
}

function ActivityCard({
  workspaceId,
  companyId,
  memberNames,
}: {
  workspaceId: string
  companyId: string
  memberNames: Map<string, string>
}) {
  const t = useTranslations()
  const format = useFormatter()
  const activities = useCompanyActivities(workspaceId, companyId)
  if (activities.isLoading) {
    return <Spinner />
  }
  const rows = activities.data ?? []
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">{t("crm.noActivity")}</p>
    )
  }
  return (
    <ol className="divide-y" data-testid="company-activity">
      {rows.map((row) => (
        <li className="flex items-start gap-3 py-2 text-sm" key={row.id}>
          <div className="min-w-0 flex-1 break-words">
            {describeCompanyActivity(row, t)}
          </div>
          <div className="shrink-0 text-end text-muted-foreground text-xs">
            <div>
              {format.dateTime(new Date(row.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </div>
            {row.actorId ? <div>{memberNames.get(row.actorId)}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  )
}

function TimelineCard({
  workspaceId,
  companyId,
  stageNames,
  onOpenDeal,
}: {
  workspaceId: string
  companyId: string
  stageNames: Map<string, string>
  onOpenDeal: (dealId: string) => void
}) {
  const [kinds, setKinds] = useState<TimelineKind[]>([])
  const timeline = useCompanyTimeline(workspaceId, companyId, kinds)
  return (
    <TimelineList
      availableKinds={COMPANY_KINDS}
      hasMore={Boolean(timeline.hasNextPage)}
      kinds={kinds}
      loading={timeline.isLoading || timeline.isFetchingNextPage}
      onKindsChange={setKinds}
      onLoadMore={() => timeline.fetchNextPage()}
      onOpenDeal={onOpenDeal}
      pages={timeline.data?.pages ?? []}
      stageNames={stageNames}
    />
  )
}
