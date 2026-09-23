import { getIdFromParams } from "@chatbotx.io/utils"
import { notFound } from "next/navigation"
import { CompanyDetail } from "@/features/companies/company-detail"
import {
  getCompanyRSC,
  listCompanyContactsRSC,
} from "@/features/companies/queries"
import { requireContactsAccess } from "@/lib/auth/require-workspace-permission"

export default async function CompanyPage(props: {
  params: Promise<{ workspaceId: string; companyId: string }>
}) {
  const params = await props.params
  const workspaceId = getIdFromParams(params, "workspaceId")
  const companyId = getIdFromParams(params, "companyId")
  if (!(workspaceId && companyId)) {
    return notFound()
  }
  await requireContactsAccess(workspaceId)

  const [company, contacts] = await Promise.all([
    getCompanyRSC({ workspaceId, id: companyId }),
    listCompanyContactsRSC({ workspaceId, companyId }),
  ])

  return (
    <CompanyDetail
      company={company}
      contacts={contacts}
      workspaceId={workspaceId}
    />
  )
}
