"use client"

import { parseEmailSuppression } from "@chatbotx.io/database/partials"
import { Badge } from "@chatbotx.io/ui/components/ui/badge"
import { Button } from "@chatbotx.io/ui/components/ui/button"
import { Card, CardContent } from "@chatbotx.io/ui/components/ui/card"
import { Input } from "@chatbotx.io/ui/components/ui/input"
import { useTranslations } from "next-intl"
import { type FormEvent, useState } from "react"
import { toast } from "sonner"
import { ConfirmButton } from "@/components/confirm-button"
import {
  useAddEmailSuppression,
  useEmailSuppressions,
  useRemoveEmailSuppression,
} from "../provider/email-suppression-hooks"

const errorMessage = (err: unknown) =>
  err instanceof Error && err.message ? err.message : String(err)

/** Settings > Email suppression: addresses and @domains the email step never mails. */
export function EmailSuppressionSettings({
  workspaceId,
}: {
  workspaceId: string
}) {
  const t = useTranslations("emailSuppression")
  const list = useEmailSuppressions(workspaceId)
  const add = useAddEmailSuppression()
  const remove = useRemoveEmailSuppression()
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const items = list.data?.pages.flatMap((page) => page.data) ?? []

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    // The same closed parser the service runs; the server stays the authority.
    if (!parseEmailSuppression(value).ok) {
      setError(t("placeholder"))
      return
    }
    setError(null)
    add.mutate(
      { workspaceId, value },
      {
        onSuccess: () => {
          setValue("")
          toast.success(t("added"))
        },
        onError: (err) => setError(errorMessage(err)),
      },
    )
  }

  return (
    <div className="space-y-4 px-4 py-4 md:px-6">
      <div className="space-y-1">
        <h2 className="font-semibold text-lg">{t("title")}</h2>
        <p className="max-w-2xl text-muted-foreground text-sm">
          {t("description")}
        </p>
      </div>
      <form
        className="flex max-w-xl flex-col gap-2 sm:flex-row sm:items-start"
        onSubmit={onSubmit}
      >
        <div className="min-w-0 flex-1 space-y-1">
          <Input
            aria-invalid={error ? true : undefined}
            aria-label={t("placeholder")}
            data-testid="email-suppression-input"
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
            placeholder={t("placeholder")}
            value={value}
          />
          {error ? (
            <p
              className="text-destructive text-xs"
              data-testid="email-suppression-error"
            >
              {error}
            </p>
          ) : null}
        </div>
        <Button
          data-testid="email-suppression-add"
          disabled={add.isPending || value.trim() === ""}
          type="submit"
        >
          {t("add")}
        </Button>
      </form>
      <Card className="max-w-xl">
        <CardContent className="divide-y p-0">
          {items.length === 0 && !list.isLoading ? (
            <p className="p-4 text-muted-foreground text-sm">{t("empty")}</p>
          ) : null}
          {items.map((item) => (
            <div
              className="flex items-center gap-3 px-4 py-3"
              data-testid="email-suppression-row"
              key={item.id}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-sm">
                {item.value}
              </span>
              <Badge variant="secondary">
                {item.reason === "unreachable"
                  ? t("reasonUnreachable")
                  : t("reasonManual")}
              </Badge>
              <ConfirmButton
                description={t("removeConfirm")}
                onConfirm={() =>
                  remove.mutate(
                    { workspaceId, id: item.id },
                    { onError: (err) => toast.error(errorMessage(err)) },
                  )
                }
                size="sm"
                title={`${t("remove")} ${item.value}?`}
                variant="ghost"
              >
                {t("remove")}
              </ConfirmButton>
            </div>
          ))}
        </CardContent>
      </Card>
      {list.hasNextPage ? (
        <Button
          disabled={list.isFetchingNextPage}
          onClick={() => list.fetchNextPage()}
          size="sm"
          variant="outline"
        >
          {t("loadMore")}
        </Button>
      ) : null}
    </div>
  )
}
