import { notFound } from "next/navigation"
import type { SearchParams } from "nuqs/server"
import { Suspense } from "react"
import { CustomFieldStoreProvider } from "@/features/custom-fields/provider/custom-field-store-context"
import { getSequence } from "@/features/sequences/queries"
import { SequenceEditor } from "@/features/sequences/sequence-editor"
import { withWorkspaceIdAndIdSchema } from "@/features/workspaces/schema/resource"

export default async function SequenceDetailPage(props: {
  params: Promise<{ workspaceId: string; id: string }>
  searchParams: Promise<SearchParams>
}) {
  const { data } = await withWorkspaceIdAndIdSchema.safeParse(
    await props.params,
  )
  if (!data) {
    return notFound()
  }

  const { workspaceId, id } = data
  const sequence = await getSequence(workspaceId, id)

  // s228b: the step card's "Hold if missing" field (s227b) reads the
  // workspace's custom fields; without the provider every sequence editor
  // crashed ("useCustomFieldStore must be used within ...").
  return (
    <Suspense>
      <CustomFieldStoreProvider workspaceId={workspaceId}>
        <SequenceEditor sequence={sequence} workspaceId={workspaceId} />
      </CustomFieldStoreProvider>
    </Suspense>
  )
}
