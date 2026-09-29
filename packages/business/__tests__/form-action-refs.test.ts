import { formSettingsSchema } from "@chatbotx.io/database/partials"
import { describe, expect, test, vi } from "vitest"

vi.mock("@chatbotx.io/database/client", () => ({
  and: (...c: unknown[]) => ({ c }),
  eq: (f: unknown, v: unknown) => ({ f, v }),
  inArray: (f: unknown, v: unknown) => ({ f, v }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  customFieldModel: {
    _name: "CustomField",
    id: "id",
    type: "type",
    workspaceId: "ws",
  },
  workspaceMemberModel: {
    _name: "WorkspaceMember",
    userId: "userId",
    workspaceId: "ws",
  },
}))

const { assertFormActionRefs } = await import("../src/form/action-refs")

/** A tx whose selects answer from the table named in `from`. */
const txWith = (rows: {
  fields?: { id: string; type: string }[]
  members?: { userId: string }[]
}) => {
  const select = () => {
    let table = ""
    const self: Record<string, unknown> = {
      from: (t: { _name: string }) => {
        table = t._name
        return self
      },
      where: () =>
        Promise.resolve(
          table === "CustomField" ? (rows.fields ?? []) : (rows.members ?? []),
        ),
    }
    return self
  }
  return { select } as never
}

const run = (actions: unknown[], rows: Parameters<typeof txWith>[0] = {}) =>
  assertFormActionRefs({
    tx: txWith(rows),
    workspaceId: "ws-1",
    actions: formSettingsSchema.parse({ actions }).actions,
  })

describe("form action schema (s220 A2-3)", () => {
  test("is closed: an unknown type, an unknown key or an empty list refuses", () => {
    const bad = [
      [{ type: "sendSms", to: "x" }],
      [{ type: "addPoints", customFieldId: "1", extra: true }],
      [{ type: "removeTags", names: [] }],
      [{ type: "notifyUsers", userIds: ["1", "1"] }],
      [{ type: "addPoints", customFieldId: "not-an-id" }],
      Array.from({ length: 21 }, () => ({ type: "removeTags", names: ["a"] })),
    ]
    for (const actions of bad) {
      expect(formSettingsSchema.safeParse({ actions }).success).toBe(false)
    }
  })

  test("defaults to none; an old settings row without the key still parses", () => {
    expect(formSettingsSchema.parse({}).actions).toEqual([])
  })
})

describe("assertFormActionRefs", () => {
  test("accepts live references", async () => {
    await expect(
      run(
        [
          { type: "addPoints", customFieldId: "10" },
          { type: "setField", customFieldId: "11", value: "vip" },
          { type: "notifyUsers", userIds: ["7"] },
          { type: "removeTags", names: ["lead"] },
        ],
        {
          fields: [
            { id: "10", type: "number" },
            { id: "11", type: "text" },
          ],
          members: [{ userId: "7" }],
        },
      ),
    ).resolves.toBeUndefined()
  })

  test("points into a non-number field, or a field not here, refuse with its path", async () => {
    await expect(
      run([{ type: "addPoints", customFieldId: "11" }], {
        fields: [{ id: "11", type: "text" }],
      }),
    ).rejects.toThrow("number field")
    await expect(
      run([{ type: "setField", customFieldId: "99", value: "x" }]),
    ).rejects.toThrow("does not exist")
  })

  test("a notified user who is not a member refuses", async () => {
    await expect(
      run([{ type: "notifyUsers", userIds: ["7", "8"] }], {
        members: [{ userId: "7" }],
      }),
    ).rejects.toThrow("not a member")
  })

  test("no actions = no queries", async () => {
    const select = vi.fn()
    await assertFormActionRefs({
      tx: { select } as never,
      workspaceId: "ws-1",
      actions: [],
    })
    expect(select).not.toHaveBeenCalled()
  })
})
