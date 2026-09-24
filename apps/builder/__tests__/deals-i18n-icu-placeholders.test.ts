import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

/**
 * ICU MessageFormat treats a single quote as an escape: `'{key}'` renders the
 * LITERAL text "{key}" (seen live on the deal activity log, s192). Every deal
 * message that carries a placeholder must not wrap it in single quotes.
 */
const en = JSON.parse(readFileSync("messages/en.json", "utf8")) as {
  deals: { activity: Record<string, unknown>; tasks: Record<string, unknown> }
}

describe("deal i18n messages never single-quote an ICU placeholder", () => {
  const flat = (
    obj: Record<string, unknown>,
    prefix = "",
  ): [string, string][] =>
    Object.entries(obj).flatMap(([k, v]) =>
      typeof v === "string"
        ? [[`${prefix}${k}`, v] as [string, string]]
        : flat(v as Record<string, unknown>, `${prefix}${k}.`),
    )
  test.each([
    ...flat(en.deals.activity, "deals.activity."),
    ...flat(en.deals.tasks, "deals.tasks."),
  ])("%s", (_key, message) => {
    expect(message).not.toMatch(/'\{[a-zA-Z]+\}'/)
  })

  test("fieldChanged and the task activities interpolate their placeholders", () => {
    expect(en.deals.activity.fieldChanged).toBe(
      "Field {key} changed from {from} to {to}",
    )
    expect(en.deals.activity.taskCreated).toBe("Task {title} created")
    expect(en.deals.activity.taskCompleted).toBe("Task {title} completed")
  })
})
