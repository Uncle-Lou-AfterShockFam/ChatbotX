import { formService, formSubmitService } from "@chatbotx.io/business/form"
import { FORM_SLUG_REGEX, MAX_FORM_TEXT } from "@chatbotx.io/database/partials"
import { getIdFromParams } from "@chatbotx.io/utils"
import type { FormValues } from "@chatbotx.io/utils/form"
import { notFound } from "next/navigation"
import { PublicForm } from "@/features/forms/components/public-form"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

export const dynamic = "force-dynamic"

/**
 * The public form page (s200): `/forms/<workspaceId>/<slug>[?embed=1&<key>=...]`.
 * No session; a draft, archived or unknown slug is a 404 (never "this form
 * is not published"). Prefill reads only the keys the form allows, each
 * clipped, and every prefilled value is still validated on submit.
 */
export default async function PublicFormPage(props: {
  params: Promise<{ workspaceId: string; slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await props.params
  const workspaceId = getIdFromParams(params, "workspaceId")
  const slug = params.slug
  if (!(workspaceId && FORM_SLUG_REGEX.test(slug))) {
    return notFound()
  }
  const { servable } = await loadServableWorkspace(workspaceId)
  if (!servable) {
    return notFound()
  }
  const form = await formService.findPublishedBySlug({ workspaceId, slug })
  if (!form?.publishedDefinition) {
    return notFound()
  }
  const search = await props.searchParams
  const embed = search.embed === "1" || search.embed === "true"
  // s220c A2-4: outside its window or full, the page says so (HTTP 200, the
  // form's own words) instead of offering a form the submit would refuse.
  const closed = await formSubmitService.availability(form, new Date())
  let closedMessage: string | null = null
  if (closed === "pending") {
    closedMessage = form.settings.pendingMessage
  } else if (closed !== null) {
    closedMessage = form.settings.closedMessage
  }
  const prefill: FormValues = {}
  for (const key of form.settings.prefillKeys) {
    const raw = search[key]
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === "string" && value !== "") {
      prefill[key] = value.slice(0, MAX_FORM_TEXT)
    }
  }

  return (
    <PublicForm
      closedMessage={closedMessage}
      definition={form.publishedDefinition}
      embed={embed}
      embedOrigins={form.settings.embedOrigins}
      prefill={prefill}
      slug={slug}
      title={form.title}
      workspaceId={workspaceId}
    />
  )
}
