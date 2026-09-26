"use client"

import { Button } from "@chatbotx.io/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@chatbotx.io/ui/components/ui/dialog"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { Label } from "@chatbotx.io/ui/components/ui/label"
import { Textarea } from "@chatbotx.io/ui/components/ui/textarea"
import { Loader2Icon, PlusIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useId, useState } from "react"
import { toast } from "sonner"
import { useCreateInvoice } from "../provider/invoice-hooks"

type Line = {
  key: number
  description: string
  quantity: string
  unitAmount: string
}

const MAX_LINES = 50
const CURRENCY_CODE = /^[A-Za-z]{3}$/
const newLine = (key: number): Line => ({
  key,
  description: "",
  quantity: "1",
  unitAmount: "",
})

/**
 * Invoice one contact through the workspace's Stripe. One idempotency key per
 * dialog opening, so a double submit returns the same invoice.
 */
export function CreateInvoiceDialog({
  workspaceId,
  contactId,
}: {
  workspaceId: string
  contactId: string
}) {
  const t = useTranslations()
  const formId = useId()
  const create = useCreateInvoice()
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState<Line[]>([newLine(0)])
  const [currency, setCurrency] = useState("USD")
  const [dueInDays, setDueInDays] = useState("7")
  const [memo, setMemo] = useState("")
  // One key per request CONTENT: a double submit of the same form reuses it,
  // an edited resubmit gets a new one (the server refuses a reused key with
  // different content).
  const [submitted, setSubmitted] = useState<{ key: string; body: string }>()

  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) {
      setLines([newLine(0)])
      setMemo("")
      setSubmitted(undefined)
    }
  }
  const update = (key: number, patch: Partial<Line>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    )

  const valid =
    lines.every(
      (line) =>
        line.description.trim() &&
        line.unitAmount.trim() &&
        Number.isInteger(Number(line.quantity)) &&
        Number(line.quantity) >= 1,
    ) && CURRENCY_CODE.test(currency.trim())

  const onSubmit = () => {
    const request = {
      workspaceId,
      contactId,
      currency: currency.trim().toUpperCase(),
      dueInDays: Math.max(0, Math.min(365, Number(dueInDays) || 0)),
      memo: memo.trim() || undefined,
      lines: lines.map((line) => ({
        description: line.description.trim(),
        quantity: Number(line.quantity),
        unitAmount: line.unitAmount.trim(),
      })),
    }
    const body = JSON.stringify(request)
    const key = submitted?.body === body ? submitted.key : crypto.randomUUID()
    setSubmitted({ key, body })
    create.mutate(
      { ...request, idempotencyKey: key },
      {
        onSuccess: () => {
          toast.success(t("invoices.created"))
          setOpen(false)
        },
        onError: (err) =>
          toast.error(err instanceof Error ? err.message : String(err)),
      },
    )
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogTrigger
        render={
          <Button data-testid="invoice-create" size="sm" variant="outline">
            <PlusIcon className="me-1 size-4" />
            {t("invoices.create")}
          </Button>
        }
      />
      <DialogContent className="max-h-screen overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("invoices.create")}</DialogTitle>
          <DialogDescription>{t("invoices.createHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          id={formId}
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !create.isPending) {
              onSubmit()
            }
          }}
        >
          <div className="space-y-2">
            {lines.map((line, index) => (
              <div className="flex flex-wrap items-end gap-2" key={line.key}>
                <div className="min-w-40 flex-1 space-y-1">
                  <Label htmlFor={`${formId}-d-${line.key}`}>
                    {t("invoices.fields.description")}
                  </Label>
                  <Input
                    id={`${formId}-d-${line.key}`}
                    maxLength={500}
                    onChange={(e) =>
                      update(line.key, { description: e.target.value })
                    }
                    value={line.description}
                  />
                </div>
                <div className="w-20 space-y-1">
                  <Label htmlFor={`${formId}-q-${line.key}`}>
                    {t("invoices.fields.quantity")}
                  </Label>
                  <Input
                    id={`${formId}-q-${line.key}`}
                    inputMode="numeric"
                    onChange={(e) =>
                      update(line.key, { quantity: e.target.value })
                    }
                    value={line.quantity}
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label htmlFor={`${formId}-a-${line.key}`}>
                    {t("invoices.fields.unitAmount")}
                  </Label>
                  <Input
                    id={`${formId}-a-${line.key}`}
                    inputMode="decimal"
                    onChange={(e) =>
                      update(line.key, { unitAmount: e.target.value })
                    }
                    placeholder="25.00"
                    value={line.unitAmount}
                  />
                </div>
                <Button
                  aria-label={t("actions.remove")}
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((current) => current.filter((_, i) => i !== index))
                  }
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <XIcon className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              disabled={lines.length >= MAX_LINES}
              onClick={() =>
                setLines((current) => [
                  ...current,
                  newLine((current.at(-1)?.key ?? 0) + 1),
                ])
              }
              size="sm"
              type="button"
              variant="outline"
            >
              {t("invoices.addLine")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <div className="w-24 space-y-1">
              <Label htmlFor={`${formId}-cur`}>
                {t("invoices.fields.currency")}
              </Label>
              <Input
                id={`${formId}-cur`}
                maxLength={3}
                onChange={(e) => setCurrency(e.target.value)}
                value={currency}
              />
            </div>
            <div className="w-32 space-y-1">
              <Label htmlFor={`${formId}-due`}>
                {t("invoices.fields.dueInDays")}
              </Label>
              <Input
                id={`${formId}-due`}
                inputMode="numeric"
                onChange={(e) => setDueInDays(e.target.value)}
                value={dueInDays}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${formId}-memo`}>
              {t("invoices.fields.memo")}
            </Label>
            <Textarea
              id={`${formId}-memo`}
              maxLength={1000}
              onChange={(e) => setMemo(e.target.value)}
              value={memo}
            />
          </div>
        </form>
        <DialogFooter>
          <Button
            disabled={!valid || create.isPending}
            form={formId}
            type="submit"
          >
            {create.isPending ? (
              <Loader2Icon className="me-1 size-4 animate-spin" />
            ) : null}
            {t("invoices.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
