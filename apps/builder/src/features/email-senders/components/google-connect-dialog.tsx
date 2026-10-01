"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
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
import { useTranslations } from "next-intl"
import { useAction } from "next-safe-action/hooks"
import { useState } from "react"
import { toast } from "sonner"
import { startEmailSenderGoogleConnectAction } from "../actions/connect-google.action"
import type { EmailSenderResource } from "../schema/resource"

const ADMIN_STEPS = ["googleStep1", "googleStep2", "googleStep3"] as const

/**
 * Connect (or reconnect) a Gmail / Google Workspace mailbox (s230b). Shows
 * the hub's Google Client ID with the steps a Workspace admin takes to
 * trust it, then hands the browser to Google's consent screen.
 */
export function GoogleConnectDialog(props: {
  workspaceId: string
  lineInboxId: string
  /** The disconnected Google sender to reconnect, or null for a new one. */
  sender: EmailSenderResource | null
  clientId: string | null
  onClose: () => void
}) {
  const t = useTranslations("emailSenders")
  const [names, setNames] = useState({
    fromName: "",
    firstName: "",
    lastName: "",
  })
  const connect = useAction(
    startEmailSenderGoogleConnectAction.bind(null, props.workspaceId),
    {
      onSuccess: ({ data }) => {
        if (data?.url) {
          window.location.assign(data.url)
        }
      },
      onError: ({ error }) =>
        toast.error(error.serverError ?? t("outcome.failed")),
    },
  )
  const reconnect = props.sender !== null
  const namesMissing =
    !reconnect && Object.values(names).some((value) => value.trim() === "")

  const copyClientId = async () => {
    if (!props.clientId) {
      return
    }
    try {
      await navigator.clipboard.writeText(props.clientId)
      toast.success(t("copied"))
    } catch {
      toast.error(t("copyFailed"))
    }
  }

  const start = () =>
    connect.execute(
      props.sender
        ? { lineInboxId: props.lineInboxId, senderId: props.sender.id }
        : { lineInboxId: props.lineInboxId, ...names },
    )

  return (
    <Dialog onOpenChange={(open) => (open ? null : props.onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {props.sender
              ? t("googleReconnectTitle", { address: props.sender.address })
              : t("googleTitle")}
          </DialogTitle>
          <DialogDescription>{t("googleDescription")}</DialogDescription>
        </DialogHeader>
        {props.clientId ? (
          <div className="space-y-4">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="email-sender-google-client-id">
                {t("googleClientId")}
              </Label>
              <div className="flex gap-2">
                <Input
                  className="min-w-0 font-mono text-xs"
                  data-testid="email-sender-google-client-id"
                  id="email-sender-google-client-id"
                  readOnly
                  value={props.clientId}
                />
                <Button
                  data-testid="email-sender-google-copy"
                  onClick={copyClientId}
                  type="button"
                  variant="outline"
                >
                  {t("copy")}
                </Button>
              </div>
            </div>
            <div className="space-y-2 rounded-md border p-3">
              <p className="font-medium text-sm">{t("googleAdminSteps")}</p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
                {ADMIN_STEPS.map((key) => (
                  <li key={key}>{t(key)}</li>
                ))}
              </ol>
              <p className="text-muted-foreground text-sm">
                {t("googleGmailNote")}
              </p>
            </div>
            {reconnect ? null : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {(["fromName", "firstName", "lastName"] as const).map((key) => (
                  <div className="min-w-0 space-y-1" key={key}>
                    <Label htmlFor={`email-sender-google-${key}`}>
                      {t(key)}
                    </Label>
                    <Input
                      data-testid={`email-sender-google-${key}`}
                      id={`email-sender-google-${key}`}
                      maxLength={100}
                      onChange={(event) =>
                        setNames((n) => ({ ...n, [key]: event.target.value }))
                      }
                      value={names[key]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p
            className="text-destructive text-sm"
            data-testid="email-sender-google-not-configured"
          >
            {t("googleNotConfigured")}
          </p>
        )}
        <DialogFooter>
          <Button onClick={props.onClose} type="button" variant="outline">
            {t("cancel")}
          </Button>
          <Button
            data-testid="email-sender-google-continue"
            disabled={!props.clientId || namesMissing || connect.isPending}
            onClick={start}
            type="button"
          >
            {t("googleContinue")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
