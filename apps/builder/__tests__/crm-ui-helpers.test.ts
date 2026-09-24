import { describe, expect, test } from "vitest"
import { describeCompanyActivity } from "@/features/crm/components/timeline-list"

// next-intl `t` stand-in: "<key>|<json values>" so the assertion sees both.
const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key}|${JSON.stringify(values)}` : key) as unknown as Parameters<
  typeof describeCompanyActivity
>[1]

describe("describeCompanyActivity (s195)", () => {
  test.each([
    [
      { type: "created", payload: { name: "Acme" } },
      'crm.activity.created|{"name":"Acme"}',
    ],
    [
      { type: "updated", payload: { changed: { name: {}, phone: {} } } },
      'crm.activity.updated|{"fields":"name, phone"}',
    ],
    [{ type: "updated", payload: {} }, 'crm.activity.updated|{"fields":""}'],
    [
      { type: "stopped", payload: { reason: "reply" } },
      'crm.activity.stopped|{"reason":"reply"}',
    ],
    [
      { type: "noteAdded", payload: { excerpt: "hi" } },
      'crm.activity.noteAdded|{"excerpt":"hi"}',
    ],
    [{ type: "noteDeleted", payload: {} }, "crm.activity.noteDeleted"],
    [{ type: "contactLinked", payload: {} }, "crm.activity.contactLinked"],
    [{ type: "contactUnlinked", payload: {} }, "crm.activity.contactUnlinked"],
    [
      { type: "dealCreated", payload: { title: "Roof" } },
      'crm.activity.dealCreated|{"title":"Roof"}',
    ],
    [
      { type: "dealCreated", payload: { title: "Roof", linked: true } },
      'crm.activity.dealLinked|{"title":"Roof"}',
    ],
    [
      { type: "dealMoved", payload: { title: "Roof" } },
      'crm.activity.dealMoved|{"title":"Roof"}',
    ],
    [
      { type: "dealStatusChanged", payload: { title: "Roof", to: "won" } },
      'crm.activity.dealStatusChanged|{"title":"Roof","status":"won"}',
    ],
  ] as const)("%o", (activity, expected) => {
    expect(describeCompanyActivity(activity as never, t)).toBe(expected)
  })

  test("an unknown type (a future enum value) renders its name, never throws", () => {
    expect(
      describeCompanyActivity({ type: "future" as never, payload: {} }, t),
    ).toBe("future")
  })

  test("a non-string title never becomes 'undefined' in copy", () => {
    expect(
      describeCompanyActivity({ type: "dealMoved", payload: { title: 42 } }, t),
    ).toBe('crm.activity.dealMoved|{"title":""}')
  })
})
