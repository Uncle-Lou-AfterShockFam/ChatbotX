import {
  EMAIL_SENDER_LIMITS,
  GMAIL_APP_PASSWORD_PRESET,
} from "@chatbotx.io/database/partials"
import { type FormEvent, useState } from "react"
import type { EmailSenderResource } from "../schema/resource"
import {
  useCreateEmailSender,
  useUpdateEmailSender,
} from "./email-sender-hooks"

/**
 * The add / edit mailbox sender form (s229b): state, the Gmail preset and
 * the submit, kept out of the dialog's JSX. The server's closed parser is
 * the authority on every value.
 */
export type Server = {
  host: string
  port: string
  secure: boolean
  user: string
}

export type FormState = {
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

export function useEmailSenderForm(
  props: {
    workspaceId: string
    lineInboxId: string
    sender: EmailSenderResource | null
  },
  options: { onSaved: () => void },
) {
  const create = useCreateEmailSender()
  const update = useUpdateEmailSender()
  const [form, setForm] = useState<FormState>(() =>
    props.sender ? formOf(props.sender) : blankForm(),
  )
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<FormState>) =>
    setForm((f) => ({ ...f, ...patch }))
  const pending = create.isPending || update.isPending
  // s229b: a disconnected sender comes back only with a new password.
  const disconnected = props.sender?.status === "disconnected"

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
      onSuccess: options.onSaved,
      onError: (err: unknown) =>
        setError(
          err instanceof Error && err.message ? err.message : String(err),
        ),
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

  return {
    form,
    set,
    error,
    pending,
    disconnected,
    applyGmailPreset,
    onSubmit,
  }
}
