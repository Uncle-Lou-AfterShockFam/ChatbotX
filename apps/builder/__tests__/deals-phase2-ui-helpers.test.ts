import { describe, expect, test } from "vitest"
import { isOverdue } from "@/features/deals/deal-card"
import { describeActivity } from "@/features/deals/deal-drawer/activity-list"
import { toDateInput } from "@/features/deals/deal-drawer/details-form"
import { parseFieldInput } from "@/features/deals/deal-field-input"
import type { DealActivityResource } from "@/features/deals/schema/resource"
import { optionsFromText } from "@/features/pipelines/field-defs-editor"

// next-intl `t` stand-in: "<key>|<json values>" so the assertion sees both.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}|${JSON.stringify(values)}` : key) as unknown as Parameters<
  typeof describeActivity
>[2]

const activity = (
  type: DealActivityResource["type"],
  payload: Record<string, unknown>,
): DealActivityResource =>
  ({
    id: "a1",
    dealId: "d1",
    actorId: null,
    type,
    payload,
    createdAt: new Date("2026-09-24T00:00:00Z"),
    updatedAt: new Date("2026-09-24T00:00:00Z"),
  }) as DealActivityResource

const stages = new Map([["s1", "New"]])

describe("describeActivity (s192 types)", () => {
  test.each([
    [
      activity("titleChanged", { from: "A", to: "B" }),
      'deals.activity.titleChanged|{"from":"A","to":"B"}',
    ],
    [
      activity("currencyChanged", { from: "USD", to: "EUR" }),
      'deals.activity.currencyChanged|{"from":"USD","to":"EUR"}',
    ],
    [
      activity("dueAtChanged", {
        from: null,
        to: "2026-10-01T00:00:00.000Z",
      }),
      'deals.activity.dueAtChanged|{"from":"-","to":"2026-10-01"}',
    ],
    [
      activity("fieldChanged", { key: "roofType", from: null, to: "metal" }),
      'deals.activity.fieldChanged|{"key":"roofType","from":"-","to":"\\"metal\\""}',
    ],
    [
      activity("created", { stageId: "s1" }),
      'deals.activity.created|{"stage":"New"}',
    ],
    [activity("note", { text: "hi" }), "hi"],
  ])("%o -> %s", (row, expected) => {
    expect(describeActivity(row, stages, t)).toBe(expected)
  })

  test("an unknown type falls back to its name and never throws", () => {
    expect(
      describeActivity(
        activity("someFutureType" as DealActivityResource["type"], {}),
        stages,
        t,
      ),
    ).toBe("someFutureType")
    expect(describeActivity(activity("fieldChanged", {}), stages, t)).toBe(
      'deals.activity.fieldChanged|{"key":"","from":"-","to":"-"}',
    )
  })
})

describe("isOverdue", () => {
  const now = new Date("2026-09-24T12:00:00Z")
  test.each([
    [{ status: "open", dueAt: new Date("2026-09-23T00:00:00Z") }, true],
    [{ status: "open", dueAt: new Date("2026-09-25T00:00:00Z") }, false],
    [{ status: "won", dueAt: new Date("2026-09-23T00:00:00Z") }, false],
    [{ status: "open", dueAt: null }, false],
  ] as const)("%o -> %s", (deal, expected) => {
    expect(isOverdue(deal, now)).toBe(expected)
  })
})

describe("parseFieldInput / toDateInput / optionsFromText", () => {
  const def = (type: "number" | "shortText") => ({
    key: "k",
    label: "K",
    type,
    required: false,
  })
  test("empty clears, numbers parse, unparsable numbers stay raw for the server 422", () => {
    expect(parseFieldInput(def("number"), "")).toBeNull()
    expect(parseFieldInput(def("number"), " ")).toBeNull()
    expect(parseFieldInput(def("number"), "12.5")).toBe(12.5)
    expect(parseFieldInput(def("number"), "abc")).toBe("abc")
    expect(parseFieldInput(def("shortText"), "12")).toBe("12")
  })
  test("dates round-trip to yyyy-mm-dd; null is empty", () => {
    expect(toDateInput(new Date("2026-10-01T00:00:00Z"))).toBe("2026-10-01")
    expect(toDateInput(null)).toBe("")
    expect(toDateInput(undefined)).toBe("")
  })
  test("options: one per line, trimmed, blanks dropped", () => {
    expect(optionsFromText(" metal \n\nshingle\n")).toEqual([
      "metal",
      "shingle",
    ])
    expect(optionsFromText("")).toEqual([])
  })
})
