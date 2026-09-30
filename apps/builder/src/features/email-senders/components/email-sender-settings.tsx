"use client"

import {
  EMAIL_SENDER_LIMITS,
  type EmailSenderUserStatus,
  emailSenderUserStatuses,
  GMAIL_APP_PASSWORD_PRESET,
} from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@chatbotx.io/ui/components/ui/dialog"
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
import { useTranslations } from "next-intl"
import { type FormEvent, useMemo, useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import {
  useArchiveEmailSender,
  useCreateEmailSender,
  useEmailSenders,
  useSetEmailSenderStatus,
  useUpdateEmailSender,
} from "../provider/email-sender-hooks"
import type { EmailSenderResource } from "../schema/resource"

const errorMessage = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err)

type Server = { host: string; port: string; secure: boolean; user: string }

type FormState = {
  address: string
  fromName: string
  firstName: string
  lastName: string
  replyTo: string
  signature: string
  dailyLimit: string
  rampStart: string
  rampPercent: string
  minGapMinutes: string
  smtp: Server
  imap: Server & { mailbox: string }
  /** One password for SMTP and IMAP (the line's feed carries one). */
  password: string
}

const emptyServer = (): Server => ({
  host: "",
  port: "",
  secure: true,
  user: "",
})

const blankForm = (): FormState => ({
  address: "",
  fromName: "",
  firstName: "",
  lastName: "",
  replyTo: "",
  signature: "",
  dailyLimit: String(EMAIL_SENDER_LIMITS.dailyLimit.default),
  rampStart: "",
  rampPercent: "",
  minGapMinutes: String(EMAIL_SENDER_LIMITS.minGapMinutes.default),
  smtp: emptyServer(),
  imap: { ...emptyServer(), mailbox: "INBOX" },
  password: "",
})

const formOf = (sender: EmailSenderResource): FormState => ({
  address: sender.address,
  fromName: sender.fromName,
  firstName: sender.firstName,
  lastName: sender.lastName,
  replyTo: sender.replyTo ?? "",
  signature: sender.signature ?? "",
  dailyLimit: String(sender.dailyLimit),
  rampStart: sender.rampStart === null ? "" : String(sender.rampStart),
  rampPercent: sender.rampPercent === null ? "" : String(sender.rampPercent),
  minGapMinutes: String(sender.minGapMinutes),
  smtp: sender.connection
    ? { ...sender.connection.smtp, port: String(sender.connection.smtp.port) }
    : emptyServer(),
  imap: sender.connection
    ? { ...sender.connection.imap, port: String(sender.connection.imap.port) }
    : { ...emptyServer(), mailbox: "INBOX" },
  password: "",
})

const optionalInt = (value: string) =>
  value.trim() === "" ? null : Number(value)

/** The request body: the server's closed parser is the authority. */
function payloadOf(form: FormState) {
  const password = form.password === "" ? undefined : form.password
  return {
    fromName: form.fromName,
    firstName: form.firstName,
    lastName: form.lastName,
    replyTo: form.replyTo.trim() === "" ? null : form.replyTo,
    signature: form.signature.trim() === "" ? null : form.signature,
    dailyLimit: Number(form.dailyLimit),
    rampStart: optionalInt(form.rampStart),
    rampPercent: optionalInt(form.rampPercent),
    minGapMinutes: Number(form.minGapMinutes),
    connection: {
      smtp: { ...form.smtp, port: Number(form.smtp.port), password },
      imap: { ...form.imap, port: Number(form.imap.port), password },
    },
  }
}

function Field(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        autoComplete={props.type === "password" ? "new-password" : "off"}
        data-testid={props.id}
        disabled={props.disabled}
        id={props.id}
        onChange={(event) => props.onChange(event.target.value)}
        placeholder={props.placeholder}
        type={props.type ?? "text"}
        value={props.value}
      />
    </div>
  )
}

function ServerFields(props: {
  prefix: "smtp" | "imap"
  value: Server
  onChange: (value: Server) => void
}) {
  const t = useTranslations("emailSenders")
  const { prefix, value, onChange } = props
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_7rem]">
      <Field
        id={`email-sender-${prefix}-host`}
        label={t("host")}
        onChange={(host) => onChange({ ...value, host })}
        value={value.host}
      />
      <Field
        id={`email-sender-${prefix}-port`}
        label={t("port")}
        onChange={(port) => onChange({ ...value, port })}
        type="number"
        value={value.port}
      />
      <Field
        id={`email-sender-${prefix}-user`}
        label={t("user")}
        onChange={(user) => onChange({ ...value, user })}
        value={value.user}
      />
      <div className="flex items-end gap-2 pb-2">
        <Switch
          aria-label={t("secure")}
          checked={value.secure}
          onCheckedChange={(secure) => onChange({ ...value, secure })}
        />
        <span className="text-sm">{t("secure")}</span>
      </div>
    </div>
  )
}

function SenderDialog(props: {
  workspaceId: string
  lineInboxId: string
  sender: EmailSenderResource | null
  onClose: () => void
}) {
  const t = useTranslations("emailSenders")
  const create = useCreateEmailSender()
  const update = useUpdateEmailSender()
  const [form, setForm] = useState<FormState>(() =>
    props.sender ? formOf(props.sender) : blankForm(),
  )
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<FormState>) =>
    setForm((f) => ({ ...f, ...patch }))
  const pending = create.isPending || update.isPending

  const applyGmailPreset = () => {
    const { smtp, imap } = GMAIL_APP_PASSWORD_PRESET
    const user = form.address.trim().toLowerCase()
    set({
      smtp: { host: smtp.host, port: String(smtp.port), secure: true, user },
      imap: {
        host: imap.host,
        port: String(imap.port),
        secure: true,
        user,
        mailbox: imap.mailbox,
      },
    })
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const done = {
      onSuccess: () => {
        toast.success(t("saved"))
        props.onClose()
      },
      onError: (err: unknown) => setError(errorMessage(err)),
    }
    if (props.sender) {
      update.mutate(
        {
          workspaceId: props.workspaceId,
          id: props.sender.id,
          ...payloadOf(form),
        },
        done,
      )
      return
    }
    create.mutate(
      {
        workspaceId: props.workspaceId,
        lineInboxId: props.lineInboxId,
        provider: "smtp",
        address: form.address,
        ...payloadOf(form),
      },
      done,
    )
  }

  return (
    <Dialog onOpenChange={(open) => (open ? null : props.onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.sender ? t("editTitle") : t("addTitle")}
          </DialogTitle>
          <DialogDescription>{t("formDescription")}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" id="email-sender-form" onSubmit={onSubmit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              disabled={Boolean(props.sender)}
              id="email-sender-address"
              label={t("address")}
              onChange={(address) => set({ address })}
              placeholder="name@example.com"
              type="email"
              value={form.address}
            />
            <Field
              id="email-sender-from-name"
              label={t("fromName")}
              onChange={(fromName) => set({ fromName })}
              value={form.fromName}
            />
            <Field
              id="email-sender-first-name"
              label={t("firstName")}
              onChange={(firstName) => set({ firstName })}
              value={form.firstName}
            />
            <Field
              id="email-sender-last-name"
              label={t("lastName")}
              onChange={(lastName) => set({ lastName })}
              value={form.lastName}
            />
            <Field
              id="email-sender-reply-to"
              label={t("replyTo")}
              onChange={(replyTo) => set({ replyTo })}
              type="email"
              value={form.replyTo}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="email-sender-signature">{t("signature")}</Label>
            <Textarea
              id="email-sender-signature"
              onChange={(event) => set({ signature: event.target.value })}
              rows={3}
              value={form.signature}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium text-sm">{t("smtp")}</h3>
            <Button
              data-testid="email-sender-gmail-preset"
              onClick={applyGmailPreset}
              size="sm"
              type="button"
              variant="outline"
            >
              {t("gmailPreset")}
            </Button>
          </div>
          <ServerFields
            onChange={(smtp) => set({ smtp })}
            prefix="smtp"
            value={form.smtp}
          />
          <h3 className="font-medium text-sm">{t("imap")}</h3>
          <ServerFields
            onChange={(imap) => set({ imap: { ...form.imap, ...imap } })}
            prefix="imap"
            value={form.imap}
          />
          <Field
            id="email-sender-password"
            label={t("password")}
            onChange={(password) => set({ password })}
            placeholder={props.sender ? t("passwordKeep") : undefined}
            type="password"
            value={form.password}
          />
          <h3 className="font-medium text-sm">{t("pacing")}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field
              id="email-sender-daily-limit"
              label={t("dailyLimit")}
              onChange={(dailyLimit) => set({ dailyLimit })}
              type="number"
              value={form.dailyLimit}
            />
            <Field
              id="email-sender-min-gap"
              label={t("minGapMinutes")}
              onChange={(minGapMinutes) => set({ minGapMinutes })}
              type="number"
              value={form.minGapMinutes}
            />
            <Field
              id="email-sender-ramp-start"
              label={t("rampStart")}
              onChange={(rampStart) => set({ rampStart })}
              type="number"
              value={form.rampStart}
            />
            <Field
              id="email-sender-ramp-percent"
              label={t("rampPercent")}
              onChange={(rampPercent) => set({ rampPercent })}
              type="number"
              value={form.rampPercent}
            />
          </div>
          {error ? (
            <p
              className="text-destructive text-sm"
              data-testid="email-sender-error"
            >
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button onClick={props.onClose} type="button" variant="outline">
            {t("cancel")}
          </Button>
          <Button
            data-testid="email-sender-save"
            disabled={pending}
            form="email-sender-form"
            type="submit"
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SenderRow(props: {
  workspaceId: string
  sender: EmailSenderResource
  onEdit: () => void
}) {
  const t = useTranslations("emailSenders")
  const setStatus = useSetEmailSenderStatus()
  const archive = useArchiveEmailSender()
  const { sender } = props
  const statusItems = emailSenderUserStatuses.options.map((value) => ({
    value,
    label: t(`status.${value}`),
  }))
  return (
    <div
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
      data-testid="email-sender-row"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-sm">{sender.address}</p>
        <p className="truncate text-muted-foreground text-xs">
          {sender.fromName} · {t("dailyLimitShort", { n: sender.dailyLimit })}
        </p>
        {sender.status === "disconnected" ? (
          <p className="text-destructive text-xs">
            {t("disconnected")}
            {sender.disconnectionReason
              ? `: ${sender.disconnectionReason}`
              : ""}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {sender.status === "disconnected" ? (
          <Badge variant="destructive">{t("status.disconnected")}</Badge>
        ) : null}
        <Select
          items={statusItems}
          onValueChange={(value) =>
            setStatus.mutate(
              {
                workspaceId: props.workspaceId,
                id: sender.id,
                status: value as EmailSenderUserStatus,
              },
              { onError: (err) => toast.error(errorMessage(err)) },
            )
          }
          value={sender.status === "disconnected" ? null : sender.status}
        >
          <SelectTrigger aria-label={t("statusLabel")} className="w-32">
            <SelectValue placeholder={t("status.disconnected")} />
          </SelectTrigger>
          <SelectContent>
            {statusItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={props.onEdit} size="sm" variant="outline">
          {t("edit")}
        </Button>
        <ConfirmButton
          description={t("archiveConfirm")}
          onConfirm={() =>
            archive.mutate(
              { workspaceId: props.workspaceId, id: sender.id },
              { onError: (err) => toast.error(errorMessage(err)) },
            )
          }
          size="sm"
          title={`${t("archive")} ${sender.address}?`}
          variant="ghost"
        >
          {t("archive")}
        </ConfirmButton>
      </div>
    </div>
  )
}

/** Settings > Email senders: the mailboxes each email line sends from. */
export function EmailSenderSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("emailSenders")
  const query = useEmailSenders(workspaceId)
  const [dialog, setDialog] = useState<{
    lineInboxId: string
    sender: EmailSenderResource | null
  } | null>(null)
  const byLine = useMemo(() => {
    const map = new Map<string, EmailSenderResource[]>()
    for (const sender of query.data?.senders ?? []) {
      map.set(sender.lineInboxId, [
        ...(map.get(sender.lineInboxId) ?? []),
        sender,
      ])
    }
    return map
  }, [query.data])
  const lines = query.data?.lines ?? []

  return (
    <div className="space-y-4 px-4 py-4 md:px-6">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg">{t("title")}</h2>
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("description")}
        </p>
      </div>
      {lines.length === 0 && !query.isLoading ? (
        <p className="text-muted-foreground text-sm">{t("noLines")}</p>
      ) : null}
      {lines.map((line) => {
        const senders = byLine.get(line.id) ?? []
        return (
          <Card
            className="max-w-3xl"
            data-testid="email-sender-line"
            key={line.id}
          >
            <CardContent className="p-0">
              <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                <h3 className="min-w-0 truncate font-medium">{line.name}</h3>
                <Button
                  data-testid="email-sender-add"
                  onClick={() =>
                    setDialog({ lineInboxId: line.id, sender: null })
                  }
                  size="sm"
                >
                  {t("add")}
                </Button>
              </div>
              <div className="divide-y">
                {senders.length === 0 ? (
                  <p className="px-4 py-3 text-muted-foreground text-sm">
                    {t("empty")}
                  </p>
                ) : null}
                {senders.map((sender) => (
                  <SenderRow
                    key={sender.id}
                    onEdit={() => setDialog({ lineInboxId: line.id, sender })}
                    sender={sender}
                    workspaceId={workspaceId}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}
      {dialog ? (
        <SenderDialog
          key={dialog.sender?.id ?? `new-${dialog.lineInboxId}`}
          lineInboxId={dialog.lineInboxId}
          onClose={() => setDialog(null)}
          sender={dialog.sender}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>
  )
}
