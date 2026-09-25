"use client"

import type { FormDefinition, FormValues } from "@chatbotx.io/utils/form"
import { useTranslations } from "next-intl"
import { useEffect, useMemo, useRef, useState } from "react"
import { FormPreview } from "./form-preview"

/**
 * The public renderer around `FormPreview` (s200): the honeypot, the POST,
 * the success / redirect, and in embed mode the resize + submitted
 * messages to the host page. Messages go ONLY to an allowed origin (the
 * referrer's origin when it is in `embedOrigins`); polaris posted to `*`
 * and its host never checked the origin (s195 audit), both tightened here.
 */
export function PublicForm(props: {
  workspaceId: string
  slug: string
  title: string
  definition: FormDefinition
  prefill: FormValues
  embed: boolean
  embedOrigins: string[]
}) {
  const { workspaceId, slug, title, definition, prefill, embed, embedOrigins } =
    props
  const t = useTranslations()
  const [honeypot, setHoneypot] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  const hostOrigin = useMemo(() => {
    if (!embed || typeof document === "undefined" || document.referrer === "") {
      return null
    }
    try {
      const origin = new URL(document.referrer).origin
      return embedOrigins.includes(origin) ? origin : null
    } catch {
      return null
    }
  }, [embed, embedOrigins])

  // Embed: tell the host page our height on every layout change.
  useEffect(() => {
    if (
      !(embed && hostOrigin && root.current) ||
      typeof ResizeObserver === "undefined"
    ) {
      return
    }
    const post = () =>
      window.parent?.postMessage(
        {
          type: "chatbotx-form-resize",
          height: document.documentElement.scrollHeight,
          slug,
        },
        hostOrigin,
      )
    const observer = new ResizeObserver(post)
    observer.observe(root.current)
    post()
    return () => observer.disconnect()
  }, [embed, hostOrigin, slug])

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(
      '[data-slot="public-form-shell"]',
    )
    if (!shell) {
      return
    }
    shell.dataset.embed = embed ? "true" : "false"
    for (const slot of ["public-form-header", "public-form-theme"]) {
      const el = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`)
      if (el) {
        el.style.display = embed ? "none" : ""
      }
    }
  }, [embed])

  const submit = async (values: FormValues) => {
    setSubmitting(true)
    setFailure(null)
    try {
      const res = await fetch(`/api/forms/${workspaceId}/${slug}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          values,
          website: honeypot,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const body = (await res.json().catch(() => null)) as
        | { ok: true; successMessage: string; redirectUrl: string | null }
        | {
            ok: false
            errors?: { key: string; code: string }[]
            retryAfter?: number
          }
        | null
      if (body?.ok !== true) {
        setFailure(
          res.status === 429
            ? t("forms.public.tooMany")
            : t("forms.public.failed"),
        )
        return
      }
      if (embed && hostOrigin) {
        window.parent?.postMessage(
          {
            type: "chatbotx-form-submitted",
            slug,
            redirectUrl: body.redirectUrl,
          },
          hostOrigin,
        )
      }
      if (body.redirectUrl && !embed) {
        window.location.assign(body.redirectUrl)
        return
      }
      setDone(body.successMessage)
    } catch {
      setFailure(t("forms.public.failed"))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="rounded-lg border bg-background p-4 md:p-6"
      data-testid="public-form"
      ref={root}
    >
      {embed ? null : <h1 className="mb-4 font-semibold text-xl">{title}</h1>}
      {done ? (
        <p className="text-sm" data-testid="public-form-done" role="status">
          {done}
        </p>
      ) : (
        <>
          {/* The spam trap: hidden from people, filled by bots. */}
          <div
            aria-hidden="true"
            className="absolute top-0 -left-[9999px] h-px w-px overflow-hidden"
          >
            <label htmlFor={`hp-${slug}`}>Leave this field empty</label>
            <input
              autoComplete="off"
              id={`hp-${slug}`}
              name={`hp_${slug}`}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              type="text"
              value={honeypot}
            />
          </div>
          <FormPreview
            definition={definition}
            idPrefix={`form-${slug}`}
            initialValues={prefill}
            onSubmit={submit}
            submitLabel={t("forms.public.submit")}
            submitting={submitting}
          />
          {failure ? (
            <p
              className="mt-3 text-destructive text-sm"
              data-testid="public-form-error"
              role="alert"
            >
              {failure}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
