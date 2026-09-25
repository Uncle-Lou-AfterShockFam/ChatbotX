"use client"

import type { FormSettings } from "@chatbotx.io/database/partials"
import {
  normalizeFormDefinition,
  normalizeFormSettings,
} from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@chatbotx.io/ui/components/ui/tabs"
import { cn } from "@chatbotx.io/ui/lib/utils"
import type { FormDefinition, FormStep } from "@chatbotx.io/utils/form"
import { formMapsToContact, MAX_FORM_STEPS } from "@chatbotx.io/utils/form"
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import {
  addStep,
  conditionSources,
  removeStep,
  updateStep,
} from "../lib/editor-ops"
import {
  useForm,
  usePublishForm,
  useSetFormStatus,
  useUpdateForm,
} from "../provider/form-hooks"
import type { FormResource } from "../schema/resource"
import { ConditionGroupEditor } from "./condition-group-editor"
import { FieldInspector } from "./field-inspector"
import { FieldList } from "./field-list"
import { FormPreview } from "./form-preview"
import { FormRulesEditor } from "./form-rules-editor"
import { FormSettingsPanel } from "./form-settings-panel"

type Draft = {
  title: string
  slug: string
  inboxId: string | null
  definition: FormDefinition
  settings: FormSettings
}

const toDraft = (form: FormResource): Draft => ({
  title: form.title,
  slug: form.slug,
  inboxId: form.inboxId,
  definition: normalizeFormDefinition(form.definition),
  settings: normalizeFormSettings(form.settings),
})

/**
 * The form builder (s200): steps on the left, the selected step's fields in
 * the middle, the selected field's inspector on the right; Rules, Settings
 * and Preview as tabs. The draft is local until Save; Publish copies the
 * saved draft to the public definition.
 */
export function FormEditor(props: { workspaceId: string; id: string }) {
  const { workspaceId, id } = props
  const t = useTranslations()
  const query = useForm(workspaceId, id)
  const update = useUpdateForm()
  const publish = usePublishForm()
  const setStatus = useSetFormStatus()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [stepId, setStepId] = useState<string | null>(null)
  const [fieldKey, setFieldKey] = useState<string | null>(null)
  const [tab, setTab] = useState("build")

  // Load once per fetched version; a background refetch never clobbers edits.
  useEffect(() => {
    const form = query.data
    if (!form) {
      return
    }
    const stamp = form.updatedAt.toISOString()
    if (draft === null || (loadedAt !== stamp && !dirty(draft, form))) {
      setDraft(toDraft(form))
      setLoadedAt(stamp)
      setStepId(
        (s) =>
          s ?? normalizeFormDefinition(form.definition).steps[0]?.id ?? null,
      )
    }
  }, [query.data, draft, loadedAt])

  const form = query.data
  const isDirty = useMemo(
    () => (draft && form ? dirty(draft, form) : false),
    [draft, form],
  )
  if (!(form && draft)) {
    return (
      <div className="flex items-center gap-2 p-4 text-muted-foreground text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        {query.isError ? t("forms.loadError") : null}
      </div>
    )
  }
  const def = draft.definition
  const step = def.steps.find((s) => s.id === stepId) ?? def.steps[0] ?? null
  const field = step?.fields.find((f) => f.key === fieldKey) ?? null
  const setDefinition = (definition: FormDefinition) =>
    setDraft((d) => (d ? { ...d, definition } : d))
  const mapsToContact = formMapsToContact(def)
  const busy = update.isPending || publish.isPending || setStatus.isPending

  const save = () =>
    update.mutateAsync(
      {
        workspaceId,
        id,
        title: draft.title,
        slug: draft.slug,
        definition: draft.definition,
        settings: draft.settings,
        inboxId: draft.inboxId,
      },
      {
        onSuccess: (saved) => {
          setLoadedAt(saved.updatedAt.toISOString())
          setDraft(toDraft(saved))
          toast.success(t("forms.saved"))
        },
        onError: (error) => toast.error(error.message),
      },
    )

  return (
    <div className="flex flex-col gap-4" data-testid="form-editor">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto font-semibold text-lg">{draft.title}</h1>
        <Badge variant={form.status === "published" ? "default" : "secondary"}>
          {t(`forms.status.${form.status}`)}
          {form.status === "published" ? ` · v${form.definitionVersion}` : ""}
        </Badge>
        {busy ? (
          <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        ) : null}
        <Button
          data-testid="form-save"
          disabled={busy || !isDirty}
          onClick={() => save().catch(() => undefined)}
          size="sm"
          variant="outline"
        >
          {t("forms.actions.save")}
        </Button>
        {form.status === "published" ? (
          <Button
            disabled={busy}
            onClick={() =>
              setStatus.mutate(
                { workspaceId, id, status: "draft" },
                { onError: (error) => toast.error(error.message) },
              )
            }
            size="sm"
            variant="ghost"
          >
            {t("forms.actions.unpublish")}
          </Button>
        ) : null}
        <Button
          data-testid="form-publish"
          disabled={busy}
          onClick={async () => {
            try {
              if (isDirty) {
                await save()
              }
              await publish.mutateAsync({ workspaceId, id })
              toast.success(t("forms.published"))
            } catch (error) {
              toast.error(
                error instanceof Error ? error.message : String(error),
              )
            }
          }}
          size="sm"
        >
          {t("forms.actions.publish")}
        </Button>
      </div>
      {mapsToContact && draft.inboxId === null ? (
        <p className="text-destructive text-sm" role="alert">
          {t("forms.settings.inboxHint")}
        </p>
      ) : null}
      {!mapsToContact && def.steps.some((s) => s.fields.length > 0) ? (
        <p className="text-muted-foreground text-xs">
          {t("forms.publishWarnings.noContact")}
        </p>
      ) : null}
      <Tabs onValueChange={(v) => setTab(String(v))} value={tab}>
        <TabsList>
          <TabsTrigger value="build">{t("forms.editor.build")}</TabsTrigger>
          <TabsTrigger value="rules">{t("forms.editor.rules")}</TabsTrigger>
          <TabsTrigger value="settings">
            {t("forms.editor.settings")}
          </TabsTrigger>
          <TabsTrigger value="preview">{t("forms.editor.preview")}</TabsTrigger>
        </TabsList>
        <TabsContent value="build">
          <div className="grid gap-4 lg:grid-cols-[14rem_1fr_20rem]">
            <div className="flex flex-col gap-2" data-testid="step-list">
              <span className="font-medium text-sm">
                {t("forms.editor.steps")}
              </span>
              {def.steps.map((s, i) => (
                <div
                  className={cn(
                    "flex items-center gap-1 rounded-md border p-1",
                    step?.id === s.id && "border-primary",
                  )}
                  data-testid={`step-row-${s.id}`}
                  key={s.id}
                >
                  <button
                    className="min-w-0 grow truncate px-2 py-1 text-start text-sm"
                    onClick={() => {
                      setStepId(s.id)
                      setFieldKey(null)
                    }}
                    type="button"
                  >
                    {s.title || `${t("forms.editor.step")} ${i + 1}`}
                    <span className="ms-1 text-muted-foreground text-xs">
                      ({s.fields.length})
                    </span>
                  </button>
                  <Button
                    aria-label={t("actions.delete")}
                    onClick={() => {
                      setDefinition(removeStep(def, s.id))
                      if (step?.id === s.id) {
                        setStepId(null)
                        setFieldKey(null)
                      }
                    }}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                data-testid="add-step"
                disabled={def.steps.length >= MAX_FORM_STEPS}
                onClick={() => {
                  const next = addStep(def)
                  setDefinition(next)
                  setStepId(next.steps.at(-1)?.id ?? null)
                  setFieldKey(null)
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <PlusIcon className="size-4" />
                {t("forms.actions.addStep")}
              </Button>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {step ? (
                <>
                  <Input
                    aria-label={t("forms.editor.stepTitle")}
                    onChange={(e) =>
                      setDefinition(
                        updateStep(def, step.id, { title: e.target.value }),
                      )
                    }
                    placeholder={t("forms.editor.stepTitle")}
                    value={step.title}
                  />
                  <StepCondition
                    definition={def}
                    onChange={setDefinition}
                    step={step}
                  />
                  <FieldList
                    definition={def}
                    onChange={setDefinition}
                    onSelect={setFieldKey}
                    selectedKey={fieldKey}
                    step={step}
                  />
                </>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("forms.editor.noStep")}
                </p>
              )}
            </div>
            <div className="min-w-0 rounded-md border p-3">
              {field ? (
                <FieldInspector
                  definition={def}
                  field={field}
                  key={field.key}
                  onChange={setDefinition}
                />
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("forms.editor.selectField")}
                </p>
              )}
            </div>
          </div>
        </TabsContent>
        <TabsContent value="rules">
          <FormRulesEditor definition={def} onChange={setDefinition} />
        </TabsContent>
        <TabsContent value="settings">
          <FormSettingsPanel
            inboxId={draft.inboxId}
            mapsToContact={mapsToContact}
            onInbox={(inboxId) => setDraft((d) => (d ? { ...d, inboxId } : d))}
            onSettings={(settings) =>
              setDraft((d) => (d ? { ...d, settings } : d))
            }
            onSlug={(slug) => setDraft((d) => (d ? { ...d, slug } : d))}
            onTitle={(title) => setDraft((d) => (d ? { ...d, title } : d))}
            published={form.status === "published"}
            settings={draft.settings}
            slug={draft.slug}
            title={draft.title}
            workspaceId={workspaceId}
          />
        </TabsContent>
        <TabsContent value="preview">
          <div className="max-w-xl rounded-md border p-4">
            <FormPreview
              definition={def}
              idPrefix="preview"
              key={JSON.stringify(def)}
              onSubmit={(values) => {
                toast.success(t("forms.editor.previewSubmitted"))
                // biome-ignore lint/suspicious/noConsole: the preview shows what a submit would carry
                console.info("[form preview]", values)
              }}
              submitLabel={t("forms.editor.previewSubmit")}
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

/**
 * A step's own `visibleWhen`: it may read fields of EARLIER steps only (the
 * evaluator resolves steps in order, so a later field reads as undefined).
 */
function StepCondition(props: {
  definition: FormDefinition
  step: FormStep
  onChange: (definition: FormDefinition) => void
}) {
  const { definition, step, onChange } = props
  const t = useTranslations()
  const index = definition.steps.findIndex((s) => s.id === step.id)
  const earlier = new Set(
    definition.steps.slice(0, index).flatMap((s) => s.fields.map((f) => f.key)),
  )
  const sources = conditionSources(definition).filter((f) => earlier.has(f.key))
  if (index <= 0) {
    return null
  }
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid={`step-condition-${step.id}`}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">
          {t("forms.editor.stepVisibleWhen")}
        </span>
        {step.visibleWhen ? (
          <Button
            onClick={() =>
              onChange(
                updateStep(definition, step.id, { visibleWhen: undefined }),
              )
            }
            size="sm"
            type="button"
            variant="ghost"
          >
            {t("actions.clear")}
          </Button>
        ) : (
          <Button
            data-testid={`step-condition-add-${step.id}`}
            disabled={sources.length === 0}
            onClick={() =>
              onChange(
                updateStep(definition, step.id, {
                  visibleWhen: { logic: "AND", rules: [] },
                }),
              )
            }
            size="sm"
            type="button"
            variant="outline"
          >
            <PlusIcon className="size-3" />
            {t("forms.editor.addCondition")}
          </Button>
        )}
      </div>
      {step.visibleWhen ? (
        <ConditionGroupEditor
          group={step.visibleWhen}
          onChange={(visibleWhen) =>
            onChange(updateStep(definition, step.id, { visibleWhen }))
          }
          sources={sources}
          testId={`step-visible-${step.id}`}
        />
      ) : null}
    </div>
  )
}

function dirty(draft: Draft, form: FormResource): boolean {
  const base = toDraft(form)
  return JSON.stringify(draft) !== JSON.stringify(base)
}
