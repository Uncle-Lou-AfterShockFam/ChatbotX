"use client"

import type {
  ContactsOnSequenceModel,
  SequenceModel,
} from "@chatbotx.io/database/types"
import { TERMINAL_END_REASONS } from "@chatbotx.io/sequence-scheduler/enrollment-constants"
import { SelectTagsInputField } from "@chatbotx.io/ui/components/form/select-tags-input-field"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Form } from "@chatbotx.io/ui/components/ui/form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useHookFormAction } from "@next-safe-action/adapter-react-hook-form/hooks"
import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { ReplyClassificationControl } from "@/features/reply-classification/reply-classification-control"
import { useSequenceOptions } from "@/features/sequences/provider/sequence-hook"
import { useWorkspaceId } from "@/hooks/routing"
import type { ContactResource } from "../contacts/schema/resource"
import { reactivateContactSequenceAction } from "./actions/reactivate-contact-sequence.action"
import { resumeContactSequenceAction } from "./actions/resume-contact-sequence.action"
import { updateContactSequenceAction } from "./actions/update-contact-sequence.action"
import {
  type ContactOnSequenceWithRelations,
  updateContactSequenceRequest,
} from "./schema"

/** s228b: ended subscriptions are kept as history, never shown as "in". */
const subscribedIds = (
  sequences: ContactOnSequenceWithRelations[] | undefined,
) =>
  sequences
    ?.filter((cos) => cos.status !== "ended")
    .map((cos) => cos.sequence.id)
    .filter(Boolean) ?? []

export default function UpdateContactSequenceField({
  contact,
  sequences,
  onSuccess,
}: {
  contact: ContactResource
  sequences: ContactOnSequenceWithRelations[]
  onSuccess?: (updatedSequences: ContactOnSequenceWithRelations[]) => void
}) {
  const workspaceId = useWorkspaceId()

  const t = useTranslations()

  const sequenceOptions = useSequenceOptions()
  const sequenceSelectOptions = sequenceOptions.map((sequence) => ({
    label: sequence.name,
    value: sequence.id,
  }))

  const [currentSequencesIds, setCurrentSequencesIds] = useState<string[]>(() =>
    subscribedIds(sequences),
  )

  const { form, handleSubmitWithAction } = useHookFormAction(
    updateContactSequenceAction.bind(null, workspaceId),
    zodResolver(updateContactSequenceRequest),
    {
      actionProps: {
        onSuccess: ({ data: updatedSequences }) => {
          onSuccess?.(
            updatedSequences as (ContactsOnSequenceModel & {
              sequence: SequenceModel
            })[],
          )
        },
        onError: ({ error }) => {
          if (error.serverError) {
            toast.error(error.serverError)
          }
        },
      },
      formProps: {
        mode: "onChange",
        defaultValues: {
          contactId: contact?.id ?? "",
          sequences: currentSequencesIds,
        },
      },
      errorMapProps: {},
    },
  )

  useEffect(() => {
    const newSequencesIds = subscribedIds(sequences)
    setCurrentSequencesIds(newSequencesIds)
    form.setValue("sequences", newSequencesIds)
  }, [sequences, form])

  return (
    <Form {...form}>
      <form className="flex flex-1 flex-col gap-2">
        <SelectTagsInputField
          disabled={form.formState.isSubmitting}
          emptyMessage={t("fields.noResults.label")}
          label=""
          name="sequences"
          onSelect={(selectedTags) => {
            const ids = selectedTags.map((tag) => tag.value)
            setCurrentSequencesIds(ids)
            handleSubmitWithAction()
          }}
          options={sequenceSelectOptions}
          placeholder={t("fields.search.placeholder")}
          searchPlaceholder={t("fields.search.placeholder")}
        />
        <HeldSequences
          contactId={contact?.id ?? ""}
          onResumed={(sequenceId) =>
            onSuccess?.(
              sequences.map((cos) =>
                cos.sequence.id === sequenceId
                  ? { ...cos, status: "active", lastError: null }
                  : cos,
              ),
            )
          }
          sequences={sequences}
        />
        <EndedSequences
          contactId={contact?.id ?? ""}
          onReactivated={(sequenceId) =>
            onSuccess?.(
              sequences.map((cos) =>
                cos.sequence.id === sequenceId
                  ? { ...cos, status: "active", endReason: null, endedAt: null }
                  : cos,
              ),
            )
          }
          sequences={sequences}
        />
        {contact?.id ? (
          <ReplyClassificationControl contactId={contact.id} />
        ) : null}
      </form>
    </Form>
  )
}

/**
 * s227b outreach B-1 H3: each sequence this contact is HELD in (a step's
 * required fields were missing), with the reason and a Resume action.
 */
function HeldSequences({
  contactId,
  sequences,
  onResumed,
}: {
  contactId: string
  sequences: ContactOnSequenceWithRelations[]
  onResumed: (sequenceId: string) => void
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const [pending, setPending] = useState<string | null>(null)
  const held = sequences.filter((cos) => cos.status === "held")
  if (held.length === 0) {
    return null
  }
  const resume = async (sequenceId: string) => {
    setPending(sequenceId)
    try {
      const result = await resumeContactSequenceAction(workspaceId, {
        contactId,
        sequenceId,
      })
      if (result?.serverError) {
        toast.error(result.serverError)
        return
      }
      toast.success(t("sequences.heldResumed"))
      onResumed(sequenceId)
    } finally {
      setPending(null)
    }
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="contact-held-sequences">
      {held.map((cos) => (
        <li
          className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
          key={cos.sequence.id}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="secondary">{t("sequences.heldBadge")}</Badge>
            <span className="truncate">
              {t("sequences.heldIn", {
                sequence: cos.sequence.name,
                reason: cos.lastError ?? "",
              })}
            </span>
          </span>
          <Button
            disabled={pending !== null}
            onClick={() => resume(cos.sequence.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            {t("sequences.heldResume")}
          </Button>
        </li>
      ))}
    </ul>
  )
}

/**
 * s228b: each sequence this contact's subscription ENDED in, with the
 * reason, and a Reactivate action unless it ended for good.
 */
function EndedSequences({
  contactId,
  sequences,
  onReactivated,
}: {
  contactId: string
  sequences: ContactOnSequenceWithRelations[]
  onReactivated: (sequenceId: string) => void
}) {
  const t = useTranslations()
  const workspaceId = useWorkspaceId()
  const [pending, setPending] = useState<string | null>(null)
  const ended = sequences.filter((cos) => cos.status === "ended")
  if (ended.length === 0) {
    return null
  }
  const reactivate = async (cos: ContactOnSequenceWithRelations) => {
    setPending(cos.sequence.id)
    try {
      const result = await reactivateContactSequenceAction(workspaceId, {
        contactId,
        sequenceId: cos.sequence.id,
        expectedUpdatedAt: new Date(cos.updatedAt).toISOString(),
      })
      if (result?.serverError) {
        toast.error(result.serverError)
        return
      }
      toast.success(t("sequences.endedReactivated"))
      onReactivated(cos.sequence.id)
    } finally {
      setPending(null)
    }
  }
  return (
    <ul className="flex flex-col gap-1" data-testid="contact-ended-sequences">
      {ended.map((cos) => (
        <li
          className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-xs"
          key={cos.sequence.id}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Badge variant="outline">{t("sequences.endedBadge")}</Badge>
            <span className="truncate">
              {t("sequences.endedIn", {
                sequence: cos.sequence.name,
                reason: cos.endReason ?? "",
              })}
            </span>
          </span>
          {cos.endReason && TERMINAL_END_REASONS.has(cos.endReason) ? null : (
            <Button
              disabled={pending !== null}
              onClick={() => reactivate(cos)}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("sequences.endedReactivate")}
            </Button>
          )}
        </li>
      ))}
    </ul>
  )
}
