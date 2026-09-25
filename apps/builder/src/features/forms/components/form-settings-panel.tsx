"use client"

import type { FormSettings } from "@chatbotx.io/database/partials"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@chatbotx.io/ui/components/ui/select"
import { Switch } from "@chatbotx.io/ui/components/ui/switch"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { useQuery } from "@tanstack/react-query"
import { useTranslations } from "next-intl"
import { orpc } from "@/lib/orpc/query"

const NO_INBOX = "__none__"
const LIST_SEPARATOR = /[\n,]+/

/** Title, slug, inbox and the settings jsonb of a form (s200). */
export function FormSettingsPanel(props: {
  workspaceId: string
  title: string
  slug: string
  inboxId: string | null
  settings: FormSettings
  mapsToContact: boolean
  published: boolean
  onTitle: (title: string) => void
  onSlug: (slug: string) => void
  onInbox: (inboxId: string | null) => void
  onSettings: (settings: FormSettings) => void
}) {
  const t = useTranslations()
  const inboxes = useQuery(
    orpc.inboxesAPI.listInboxesAuthenticatedAPI.queryOptions({
      input: { workspaceId: props.workspaceId },
      select: (res) => res.data.filter((inbox) => inbox.channel === "api"),
    }),
  )
  const set = (patch: Partial<FormSettings>) =>
    props.onSettings({ ...props.settings, ...patch })
  const lines = (value: string) =>
    value
      .split(LIST_SEPARATOR)
      .map((v) => v.trim())
      .filter((v) => v !== "")
  const inboxItems = [
    { value: NO_INBOX, label: t("forms.settings.inboxNone") },
    ...(inboxes.data ?? []).map((inbox) => ({
      value: inbox.id,
      label: inbox.name ?? inbox.id,
    })),
  ]

  return (
    <div className="flex max-w-xl flex-col gap-4" data-testid="form-settings">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-title">{t("forms.columns.title")}</Label>
        <Input
          id="fs-title"
          onChange={(e) => props.onTitle(e.target.value)}
          value={props.title}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-slug">{t("forms.columns.slug")}</Label>
        <Input
          id="fs-slug"
          onChange={(e) => props.onSlug(e.target.value)}
          value={props.slug}
        />
        {props.published ? (
          <span className="text-muted-foreground text-xs">
            {t("forms.settings.slugPublishedHint")}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>{t("forms.settings.inbox")}</Label>
        <Select
          items={inboxItems}
          onValueChange={(v) =>
            props.onInbox(!v || v === NO_INBOX ? null : String(v))
          }
          value={props.inboxId ?? NO_INBOX}
        >
          <SelectTrigger
            aria-invalid={props.mapsToContact && props.inboxId === null}
            className="w-full"
            data-testid="fs-inbox"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {inboxItems.map((i) => (
              <SelectItem key={i.value} value={i.value}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span
          className={
            props.mapsToContact && props.inboxId === null
              ? "text-destructive text-xs"
              : "text-muted-foreground text-xs"
          }
        >
          {t("forms.settings.inboxHint")}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-success">{t("forms.settings.successMessage")}</Label>
        <Textarea
          id="fs-success"
          onChange={(e) => set({ successMessage: e.target.value })}
          value={props.settings.successMessage}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-redirect">{t("forms.settings.redirectUrl")}</Label>
        <Input
          id="fs-redirect"
          onChange={(e) =>
            set({ redirectUrl: e.target.value === "" ? null : e.target.value })
          }
          placeholder="https://"
          value={props.settings.redirectUrl ?? ""}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-tags">{t("forms.settings.tags")}</Label>
        <Input
          id="fs-tags"
          onChange={(e) => set({ tags: lines(e.target.value) })}
          placeholder="lead, newsletter"
          value={props.settings.tags.join(", ")}
        />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
        <Label htmlFor="fs-honeypot">{t("forms.settings.honeypot")}</Label>
        <Switch
          checked={props.settings.honeypot}
          id="fs-honeypot"
          onCheckedChange={(honeypot) => set({ honeypot })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-limit">{t("forms.settings.submitLimit")}</Label>
        <Input
          id="fs-limit"
          max={1000}
          min={1}
          onChange={(e) =>
            set({ submitLimitPerIpPerHour: Number(e.target.value) || 1 })
          }
          type="number"
          value={props.settings.submitLimitPerIpPerHour}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-origins">{t("forms.settings.embedOrigins")}</Label>
        <Textarea
          id="fs-origins"
          onChange={(e) => set({ embedOrigins: lines(e.target.value) })}
          placeholder="https://www.example.com"
          value={props.settings.embedOrigins.join("\n")}
        />
        <span className="text-muted-foreground text-xs">
          {t("forms.settings.embedOriginsHint")}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="fs-prefill">{t("forms.settings.prefillKeys")}</Label>
        <Input
          id="fs-prefill"
          onChange={(e) => set({ prefillKeys: lines(e.target.value) })}
          placeholder="first_name, email"
          value={props.settings.prefillKeys.join(", ")}
        />
        <span className="text-muted-foreground text-xs">
          {t("forms.settings.prefillKeysHint")}
        </span>
      </div>
    </div>
  )
}
