"use client"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@chatbotx.io/ui/components/ui/avatar"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import { useQuery } from "@tanstack/react-query"
import {
  AtSignIcon,
  Building2Icon,
  ExternalLinkIcon,
  PencilIcon,
  PhoneIcon,
  TextIcon,
} from "lucide-react"
import Link from "next/link"
import { useFormatter, useTranslations } from "next-intl"
import { useMemo, useState } from "react"
import { ChatStoreProvider } from "@/features/chat/store/chat-store-provider"
import { ContactCompanyField } from "@/features/companies/contact-company-field"
import { ContactNotesManage } from "@/features/contact-notes/contact-notes-manage"
import { ConversationMessages } from "@/features/crm/components/conversation-messages"
import { CrmDealDrawer } from "@/features/crm/components/crm-deal-drawer"
import { DealsList } from "@/features/crm/components/deals-list"
import { NewDealButton } from "@/features/crm/components/new-deal-button"
import { Spinner } from "@/features/crm/components/spinner"
import { SubmissionsList } from "@/features/crm/components/submissions-list"
import { TasksList } from "@/features/crm/components/tasks-list"
import { TimelineList } from "@/features/crm/components/timeline-list"
import {
  useContact,
  useContactConversation,
  useContactDeals,
  useContactSubmissions,
  useContactTasks,
  useContactTimeline,
  useInvalidateCrm,
  usePipelines,
} from "@/features/crm/provider/crm-hooks"
import type { TimelineKind } from "@/features/crm/schema/resource"
import { namesById } from "@/features/deals/lib/names-by-id"
import { SequenceStoreProvider } from "@/features/sequences/provider/sequence-store-context"
import type { TagResource } from "@/features/tags/schema/resource"
import { client } from "@/lib/orpc/orpc"
import { ContactAppointmentsList } from "./components/contact-appointments-list"
import UpdateContactTagField from "./components/update-contact-tag-field"
import { EditContactField } from "./edit-contact-field"
import type { ContactEditableField } from "./schema/resource"
import { useAvatarUrl } from "./utils"

const CONTACT_KINDS: TimelineKind[] = [
  "contactNote",
  "dealActivity",
  "submission",
  "appointment",
]

/**
 * Contact 360 (s195): the one component behind the contact page AND the
 * stacked contact sheet. Every tab self-fetches and has its own empty state;
 * nothing here sends a message (the inbox link does that).
 */
export function ContactView({
  workspaceId,
  contactId,
  compact = false,
}: {
  workspaceId: string
  contactId: string
  /** inside the sheet: no back link, tighter header */
  compact?: boolean
}) {
  const t = useTranslations()
  const format = useFormatter()
  const contact = useContact(workspaceId, contactId)
  const invalidate = useInvalidateCrm()
  const [openDealId, setOpenDealId] = useState<string | null>(null)
  const [field, setField] = useState<ContactEditableField | null>(null)

  const data = contact.data ?? null
  const avatarUrl = useAvatarUrl(data)
  const name = data?.fullName || data?.email || data?.phoneNumber || ""
  const initials = (data?.fullName ?? name).slice(0, 2)

  const editable: ContactEditableField[] = useMemo(
    () =>
      data
        ? [
            {
              key: "firstName",
              icon: TextIcon,
              label: t("fields.firstName.label"),
              value: data.firstName,
              type: "shortText",
            },
            {
              key: "lastName",
              icon: TextIcon,
              label: t("fields.lastName.label"),
              value: data.lastName,
              type: "shortText",
            },
            {
              key: "email",
              icon: AtSignIcon,
              label: t("fields.email.label"),
              value: data.email,
              type: "shortText",
            },
            {
              key: "phoneNumber",
              icon: PhoneIcon,
              label: t("fields.phoneNumber.label"),
              value: data.phoneNumber,
              type: "shortText",
            },
          ]
        : [],
    [data, t],
  )

  if (contact.isLoading) {
    return <Spinner />
  }
  if (!data) {
    return (
      <p className="text-muted-foreground text-sm">{t("crm.contactMissing")}</p>
    )
  }

  return (
    <ChatStoreProvider>
      <div className="space-y-4" data-testid="contact-360">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar className="size-12">
            <AvatarImage alt={name} className="object-cover" src={avatarUrl} />
            <AvatarFallback>{initials || "?"}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <h4
              className={`truncate font-bold ${compact ? "text-lg" : "text-xl"}`}
              data-testid="contact-360-name"
            >
              {name}
            </h4>
            <div className="flex flex-wrap items-center gap-1 text-muted-foreground text-xs">
              {data.company ? (
                <Link
                  className="inline-flex items-center gap-1 hover:underline"
                  href={`/space/${workspaceId}/companies/${data.company.id}`}
                >
                  <Building2Icon className="size-3" />
                  {data.company.name}
                </Link>
              ) : null}
              {data.blockedAt ? (
                <Badge variant="destructive">{t("crm.blocked")}</Badge>
              ) : null}
              {data.subscribedAt === null ? (
                <Badge variant="outline">{t("crm.unsubscribed")}</Badge>
              ) : null}
              <span>
                {t("crm.since", {
                  date: format.dateTime(new Date(data.createdAt), {
                    dateStyle: "medium",
                  }),
                })}
              </span>
            </div>
          </div>
          {compact ? null : (
            <Button
              render={
                <Link href={`/space/${workspaceId}/contacts/${contactId}`} />
              }
              size="sm"
              variant="ghost"
            >
              <ExternalLinkIcon className="me-2 size-4" />
              {t("crm.openPage")}
            </Button>
          )}
        </div>

        <Tabs defaultValue="details">
          {/* the list's inner flex row never wraps on its own: eight tabs overflowed the sheet (s195 layout audit) */}
          <TabsList className="w-full px-4 [&>div]:flex-wrap [&>div]:gap-x-6 [&>div]:gap-y-1">
            {(
              [
                "details",
                "conversation",
                "deals",
                "tasks",
                "submissions",
                "notes",
                "appointments",
                "timeline",
              ] as const
            ).map((tab) => (
              <TabsTrigger
                data-testid={`contact-tab-${tab}`}
                key={tab}
                value={tab}
              >
                {t(`crm.tabs.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent className="space-y-4 pt-3" value="details">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {editable.map((f) => (
                <div className="min-w-0" key={f.key}>
                  <dt className="text-muted-foreground text-xs">{f.label}</dt>
                  <dd className="flex items-center gap-1">
                    <span className="truncate">{f.value || "-"}</span>
                    <Button
                      aria-label={t("actions.edit")}
                      data-testid={`contact-edit-${f.key}`}
                      onClick={() => setField(f)}
                      size="icon"
                      variant="ghost"
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  </dd>
                </div>
              ))}
              {data.customFields.map((cf) => (
                <div className="min-w-0" key={cf.id}>
                  <dt className="text-muted-foreground text-xs">{cf.name}</dt>
                  <dd className="truncate">{cf.value ?? "-"}</dd>
                </div>
              ))}
            </dl>
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">
                {t("companies.one")}
              </div>
              <ContactCompanyField
                company={
                  data.company
                    ? {
                        id: data.company.id,
                        name: data.company.name,
                        stoppedAt: data.company.stoppedAt,
                      }
                    : null
                }
                contactId={contactId}
                workspaceId={workspaceId}
              />
            </div>
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">
                {t("fields.tags.label")}
              </div>
              <UpdateContactTagField
                contact={data}
                onSuccess={(_tags: TagResource[]) => invalidate()}
                tags={data.tags}
                workspaceId={workspaceId}
              />
            </div>
            <EditContactField
              contactId={contactId}
              onOpenChange={() => setField(null)}
              onUpdated={() => invalidate()}
              open={Boolean(field)}
              targetField={field}
              workspaceId={workspaceId}
            />
          </TabsContent>

          <TabsContent className="pt-3" value="conversation">
            <ConversationTab contactId={contactId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent className="space-y-3 pt-3" value="deals">
            <NewDealButton
              presetContact={{ id: contactId, label: name }}
              workspaceId={workspaceId}
            />
            <DealsTab
              contactId={contactId}
              onOpen={setOpenDealId}
              workspaceId={workspaceId}
            />
          </TabsContent>

          <TabsContent className="pt-3" value="tasks">
            <TasksTab contactId={contactId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent className="pt-3" value="submissions">
            <SubmissionsTab contactId={contactId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent className="pt-3" value="notes">
            <ContactNotesManage
              contact={data}
              contactNotes={data.contactNotes}
            />
          </TabsContent>

          <TabsContent className="pt-3" value="appointments">
            <AppointmentsTab contactId={contactId} workspaceId={workspaceId} />
          </TabsContent>

          <TabsContent className="pt-3" value="timeline">
            <TimelineTab
              contactId={contactId}
              onOpenDeal={setOpenDealId}
              workspaceId={workspaceId}
            />
          </TabsContent>
        </Tabs>

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
    </ChatStoreProvider>
  )
}

function ConversationTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const conversation = useContactConversation(workspaceId, contactId)
  if (conversation.isLoading) {
    return <Spinner />
  }
  return (
    <ConversationMessages
      conversationId={conversation.data?.id ?? null}
      workspaceId={workspaceId}
    />
  )
}

function DealsTab({
  workspaceId,
  contactId,
  onOpen,
}: {
  workspaceId: string
  contactId: string
  onOpen: (dealId: string) => void
}) {
  const deals = useContactDeals(workspaceId, contactId)
  const pipelines = usePipelines(workspaceId)
  if (deals.isLoading) {
    return <Spinner />
  }
  return (
    <DealsList
      deals={deals.data ?? []}
      onOpen={(deal) => onOpen(deal.id)}
      pipelines={pipelines.data ?? []}
    />
  )
}

function TasksTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const tasks = useContactTasks(workspaceId, contactId)
  const deals = useContactDeals(workspaceId, contactId)
  const invalidate = useInvalidateCrm()
  if (tasks.isLoading) {
    return <Spinner />
  }
  return (
    <TasksList
      deals={deals.data ?? []}
      onChanged={invalidate}
      tasks={tasks.data ?? []}
      workspaceId={workspaceId}
    />
  )
}

function SubmissionsTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const submissions = useContactSubmissions(workspaceId, contactId)
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

function AppointmentsTab({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const appointments = useQuery({
    queryKey: ["crm", "contact-appointments", workspaceId, contactId],
    queryFn: () =>
      client.appointmentsAPI.listContactAppointmentsAPI({
        workspaceId,
        contactId,
      }),
  })
  if (appointments.isLoading) {
    return <Spinner />
  }
  return <ContactAppointmentsList appointments={appointments.data ?? []} />
}

function TimelineTab({
  workspaceId,
  contactId,
  onOpenDeal,
}: {
  workspaceId: string
  contactId: string
  onOpenDeal: (dealId: string) => void
}) {
  const pipelines = usePipelines(workspaceId)
  const stageNames = useMemo(
    () => namesById(pipelines.data ?? []),
    [pipelines.data],
  )
  const [kinds, setKinds] = useState<TimelineKind[]>([])
  const timeline = useContactTimeline(workspaceId, contactId, kinds)
  return (
    <TimelineList
      availableKinds={CONTACT_KINDS}
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
