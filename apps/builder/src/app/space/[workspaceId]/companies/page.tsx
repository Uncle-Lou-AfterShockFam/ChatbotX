import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CompaniesTable } from "@/features/companies/companies-table"
import { listCompaniesRSC } from "@/features/companies/queries"
import { listCompaniesSearchParamsCache } from "@/features/companies/schema/query"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function CompaniesPage(props: {
  params: Promise<{ workspaceId: string }>
  searchParams: Promise<SearchParams>
}) {
  const workspaceId = getIdFromParams(await props.params, "workspaceId")
  if (!workspaceId) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  const searchParams = await props.searchParams
  const search = await listCompaniesSearchParamsCache.parse(searchParams)

  const promises = Promise.all([listCompaniesRSC({ ...search, workspaceId })])

  return (
    <Suspense>
      <CompaniesTable promises={promises} workspaceId={workspaceId} />
    </Suspense>
  )
}
