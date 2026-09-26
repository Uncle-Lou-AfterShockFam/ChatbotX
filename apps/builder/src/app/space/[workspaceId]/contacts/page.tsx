import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { getTranslations } from "next-intl/server"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import {
  EMPTY_CONTACT_FILTER,
  parseContactFilterParam,
} from "@/features/contact-filter"
import { EMPTY_CONTACTS_RESPONSE } from "@/features/contacts/constants"
import { ContactsTable } from "@/features/contacts/contacts-table"
import { CreateContactDialog } from "@/features/contacts/create-contact-dialog"
import { requireContactPermissionScope } from "@/features/contacts/permissions"
import { listContactsRSC } from "@/features/contacts/queries/list-contacts.queries"
import { listContactsRequest } from "@/features/contacts/schema/query"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { FlowStoreProvider } from "@/features/flows/provider/flow-store-context"
import { InboxStoreProvider } from "@/features/inboxes/provider/inbox-store-context"
import { SequenceStoreProvider } from "@/features/sequences/provider/sequence-store-context"
import { UserStoreProvider } from "@/features/users/provider/user-store-context"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function ContactsPage(props: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<SearchParams>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)
  const contactPermissionScope =
    await requireContactPermissionScope(workspaceId)

  const t = await getTranslations()
  const searchParams = await props.searchParams
  // The filter parses on its own: a broken filter must not drop keyword /
  // page, and a broken keyword / page must not drop the filter. An invalid
  // filter lists NO contact (the table shows the invalid-filter alert): it
  // never widens to everyone (s206).
  const contactFilterParam = parseContactFilterParam(searchParams.contactFilter)
  const invalidContactFilter = contactFilterParam.status === "invalid"
  const initialContactFilter =
    contactFilterParam.status === "valid"
      ? contactFilterParam.filter
      : EMPTY_CONTACT_FILTER
  const { data: search } = listContactsRequest
    .omit({ workspaceId: true, contactFilter: true })
    .safeParse(searchParams)

  const promises = Promise.all([
    invalidContactFilter
      ? EMPTY_CONTACTS_RESPONSE
      : listContactsRSC({
          ...search,
          contactFilter:
            contactFilterParam.status === "valid"
              ? contactFilterParam.filter
              : undefined,
          workspaceId,
        }),
  ])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-bold text-xl">{t("contacts.title")}</h4>
        <CreateContactDialog workspaceId={workspaceId} />
      </div>

      <Suspense>
        <UserStoreProvider workspaceId={workspaceId}>
          <CustomFieldStoreProvider workspaceId={workspaceId}>
            <FlowStoreProvider workspaceId={workspaceId}>
              <InboxStoreProvider workspaceId={workspaceId}>
                <SequenceStoreProvider workspaceId={workspaceId}>
                  <ContactsTable
                    canViewEmailAndPhone={
                      contactPermissionScope.canViewEmailAndPhone
                    }
                    initialContactFilter={initialContactFilter}
                    promises={promises}
                    workspaceId={workspaceId}
                  />
                </SequenceStoreProvider>
              </InboxStoreProvider>
            </FlowStoreProvider>
          </CustomFieldStoreProvider>
        </UserStoreProvider>
      </Suspense>
    </div>
  )
}
