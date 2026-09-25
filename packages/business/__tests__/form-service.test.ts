import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * Queue-driven mock at the query-builder seam (documents-service pattern):
 * every SELECT / UPDATE / DELETE pops the next queued result; INSERT records
 * its values and returns them unless `insertError` is set for that call.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    updates: [] as unknown[][],
    deletes: [] as unknown[][],
    inserted: [] as Record<string, unknown>[],
    insertErrors: [] as (Error | null)[],
    calls: [] as string[],
    lastWhere: null as unknown,
  }
  const chain = (kind: "select" | "update" | "delete") => {
    const self: Record<string, unknown> = {}
    const queues = {
      select: state.selects,
      update: state.updates,
      delete: state.deletes,
    }
    for (const k of [
      "from",
      "orderBy",
      "limit",
      "set",
      "returning",
      "groupBy",
      "leftJoin",
    ]) {
      self[k] = () => self
    }
    self.where = (arg: unknown) => {
      if (kind === "update") {
        state.lastWhere = arg
      }
      return self
    }
    self.as = () => ({ count: "count", formId: "formId" })
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const next = queues[kind].shift()
      if (next === undefined) {
        return Promise.reject(
          new Error(`mock: no ${kind} queued (${state.calls.join(",")})`),
        ).then(ok, ko)
      }
      return Promise.resolve(next).then(ok, ko)
    }
    return self
  }
  const tx = {
    select: () => {
      state.calls.push("select")
      return chain("select")
    },
    update: () => {
      state.calls.push("update")
      return chain("update")
    },
    delete: () => {
      state.calls.push("delete")
      return chain("delete")
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          state.calls.push("insert")
          const err = state.insertErrors.shift() ?? null
          if (err) {
            return Promise.reject(err)
          }
          const row = {
            publishedDefinition: null,
            inboxId: null,
            ...v,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          state.inserted.push(row)
          return Promise.resolve([row])
        },
      }),
    }),
  }
  return { state, tx }
})

vi.mock("@chatbotx.io/database/client", () => {
  const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: strings.join("?"),
    values,
    as: () => ({}),
  })
  sqlTag.join = (parts: unknown[]) => ({ join: parts })
  return {
    db: m.tx,
    and: (...c: unknown[]) => ({ c }),
    eq: (f: unknown, v: unknown) => ({ f, v }),
    desc: (f: unknown) => ({ desc: f }),
    sql: sqlTag,
    isUniqueViolationError: (error: unknown, constraint?: string) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "23505" &&
      (constraint === undefined ||
        (error as { constraint?: string }).constraint === constraint),
  }
})
vi.mock("@chatbotx.io/database/schema", () => ({
  formModel: {
    id: "id",
    workspaceId: "ws",
    slug: "slug",
    status: "status",
    updatedAt: "u",
  },
  formSubmissionModel: {
    id: "id",
    workspaceId: "ws",
    formId: "formId",
    createdAt: "c",
  },
  inboxModel: { id: "id", workspaceId: "ws", channel: "channel" },
  customFieldModel: { id: "id", workspaceId: "ws" },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `id-${++n}`
  })(),
}))

import {
  DEFAULT_FORM_SETTINGS,
  EMPTY_FORM_DEFINITION,
} from "@chatbotx.io/database/partials"
import {
  decodeSubmissionCursor,
  encodeSubmissionCursor,
  formService,
} from "../src/form/service"

const SETTINGS_FIELD_RE = /^settings/
const CURSOR_RE = /cursor/
const WS = "11701868563365888"
const NOW = new Date("2026-09-25T00:00:00Z")

const draft = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  workspaceId: WS,
  title: "Demo intake",
  slug: "demo-intake",
  status: "draft",
  definition: { ...EMPTY_FORM_DEFINITION },
  publishedDefinition: null,
  definitionVersion: 0,
  settings: { ...DEFAULT_FORM_SETTINGS },
  publishedAt: null,
  inboxId: null,
  createdById: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})

const mappedDefinition = {
  steps: [
    {
      id: "s1",
      fields: [
        {
          key: "phone",
          type: "phone",
          mapTo: { kind: "system", key: "phoneNumber" },
        },
        {
          key: "size",
          type: "text",
          mapTo: { kind: "custom", customFieldId: "77" },
        },
      ],
    },
  ],
  rules: [],
}

const uniqueError = () =>
  Object.assign(new Error("duplicate key"), {
    code: "23505",
    constraint: "Form_workspaceId_slug_key",
  })

const field = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (error) {
    return error as { field?: string; httpStatusCode?: number; data?: unknown }
  }
  throw new Error("expected a rejection")
}

beforeEach(() => {
  m.state.selects.length = 0
  m.state.updates.length = 0
  m.state.deletes.length = 0
  m.state.inserted.length = 0
  m.state.insertErrors.length = 0
  m.state.calls.length = 0
})

describe("formService.create", () => {
  test("slugifies the title, writes explicit jsonb values", async () => {
    const row = await formService.create({
      workspaceId: WS,
      data: { title: "  Demo Intake!  " },
    })
    expect(row.slug).toBe("demo-intake")
    expect(m.state.inserted[0]).toMatchObject({
      definition: EMPTY_FORM_DEFINITION,
      settings: DEFAULT_FORM_SETTINGS,
      definitionVersion: 0,
      status: "draft",
    })
  })

  test.each([
    ["empty", ""],
    ["null", null],
    ["number", 12],
    ["too long", "x".repeat(121)],
  ])("refuses a %s title", async (_l, title) => {
    const e = await field(
      formService.create({ workspaceId: WS, data: { title } }),
    )
    expect(e.field).toBe("title")
    expect(e.httpStatusCode).toBe(422)
  })

  test("refuses a bad explicit slug and maps a collision to a 422 (not a 500)", async () => {
    const bad = await field(
      formService.create({
        workspaceId: WS,
        data: { title: "x", slug: "Bad Slug" },
      }),
    )
    expect(bad.field).toBe("slug")
    m.state.insertErrors.push(uniqueError())
    const dup = await field(
      formService.create({ workspaceId: WS, data: { title: "x" } }),
    )
    expect(dup.field).toBe("slug")
    expect(dup.httpStatusCode).toBe(422)
  })

  test("an unrelated insert error is not swallowed", async () => {
    m.state.insertErrors.push(new Error("connection reset"))
    await expect(
      formService.create({ workspaceId: WS, data: { title: "x" } }),
    ).rejects.toThrow("connection reset")
  })
})

describe("formService.update", () => {
  test("a strict definition failure names the path", async () => {
    m.state.selects.push([draft()])
    const e = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: {
          definition: {
            steps: [{ id: "s1", fields: [{ key: "K", type: "text" }] }],
          },
        },
      }),
    )
    expect(e.field).toBe("definition.steps.0.fields.0.key")
    expect(m.state.calls).not.toContain("update")
  })

  test("an unknown settings key is refused", async () => {
    m.state.selects.push([draft()])
    const e = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: { settings: { bogus: 1 } },
      }),
    )
    expect(e.field).toMatch(SETTINGS_FIELD_RE)
  })

  test("a definition that writes to the contact needs an inbox", async () => {
    m.state.selects.push([draft()])
    const e = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: { definition: mappedDefinition },
      }),
    )
    expect(e.field).toBe("inboxId")
    expect((e.data as { reason: string }).reason).toBe("inboxRequired")
  })

  test("the inbox must exist here and be an api channel", async () => {
    m.state.selects.push([draft()], [])
    const missing = await field(
      formService.update({ workspaceId: WS, id: "f1", data: { inboxId: "9" } }),
    )
    expect(missing.field).toBe("inboxId")
    m.state.selects.push([draft()], [{ id: "9", channel: "whatsapp" }])
    const wrong = await field(
      formService.update({ workspaceId: WS, id: "f1", data: { inboxId: "9" } }),
    )
    expect((wrong.data as { reason: string }).reason).toBe("notApiChannel")
  })

  test("a valid mapped definition + api inbox is saved", async () => {
    m.state.selects.push([draft()], [{ id: "9", channel: "api" }])
    m.state.updates.push([
      draft({ inboxId: "9", definition: mappedDefinition }),
    ])
    const row = await formService.update({
      workspaceId: WS,
      id: "f1",
      data: { definition: mappedDefinition, inboxId: "9" },
    })
    expect(row.inboxId).toBe("9")
    expect(row.definition.steps[0].fields[0].required).toBe(false)
  })

  test("renaming a published slug is refused unless forced", async () => {
    m.state.selects.push([draft({ status: "published" })])
    const e = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: { slug: "new-slug" },
      }),
    )
    expect((e.data as { reason: string }).reason).toBe("publishedSlug")
    m.state.selects.push([draft({ status: "published" })])
    m.state.updates.push([draft({ status: "published", slug: "new-slug" })])
    const row = await formService.update({
      workspaceId: WS,
      id: "f1",
      data: { slug: "new-slug" },
      force: true,
    })
    expect(row.slug).toBe("new-slug")
  })

  test("settings must be an object; a root-level issue names `settings`, not `settings.`", async () => {
    for (const bad of [null, [], "x", 5]) {
      m.state.selects.push([draft()])
      const e = await field(
        formService.update({
          workspaceId: WS,
          id: "f1",
          data: { settings: bad },
        }),
      )
      expect(e.field, JSON.stringify(bad)).toBe("settings")
    }
    expect(m.state.calls).not.toContain("update")
  })

  test("a non-int8 inboxId is a 422 before any inbox lookup", async () => {
    m.state.selects.push([draft()])
    const e = await field(
      formService.update({ workspaceId: WS, id: "f1", data: { inboxId: "" } }),
    )
    expect(e.field).toBe("inboxId")
    expect(m.state.calls).toEqual(["select"])
  })

  test("optimistic lock: a stale ifUnmodifiedSince or a moved row is a 409", async () => {
    m.state.selects.push([draft()])
    const stale = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: { title: "x" },
        ifUnmodifiedSince: new Date(NOW.getTime() - 1000),
      }),
    )
    expect(stale.httpStatusCode).toBe(409)
    expect(m.state.calls).not.toContain("update")
    // the row moved between the read and the write: 0 rows updated
    m.state.selects.push([draft()])
    m.state.updates.push([])
    const moved = await field(
      formService.update({
        workspaceId: WS,
        id: "f1",
        data: { title: "x" },
        ifUnmodifiedSince: NOW,
      }),
    )
    expect(moved.httpStatusCode).toBe(409)
  })

  test("the optimistic lock compares updatedAt at millisecond precision (timestamp(6) column)", async () => {
    m.state.selects.push([draft()])
    m.state.updates.push([draft({ title: "x" })])
    await formService.update({
      workspaceId: WS,
      id: "f1",
      data: { title: "x" },
    })
    const where = JSON.stringify(m.state.lastWhere)
    expect(where).toContain("date_trunc('milliseconds'")
    expect(where).not.toContain('"f":"u"')
  })

  test("a no-op patch does not write", async () => {
    m.state.selects.push([draft()])
    await formService.update({ workspaceId: WS, id: "f1", data: {} })
    expect(m.state.calls).toEqual(["select"])
  })

  test("unknown form -> 404", async () => {
    m.state.selects.push([])
    const e = await field(
      formService.update({ workspaceId: WS, id: "zz", data: { title: "x" } }),
    )
    expect(e.httpStatusCode).toBe(404)
  })
})

describe("formService.publish", () => {
  test("refuses an archived or empty form", async () => {
    m.state.selects.push([draft({ status: "archived" })])
    expect(
      (await field(formService.publish({ workspaceId: WS, id: "f1" }))).field,
    ).toBe("status")
    m.state.selects.push([draft()])
    expect(
      (await field(formService.publish({ workspaceId: WS, id: "f1" }))).field,
    ).toBe("definition")
  })

  test("a mapped form must identify the contact", async () => {
    const noIdentity = {
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "size",
              type: "text",
              mapTo: { kind: "custom", customFieldId: "77" },
            },
          ],
        },
      ],
      rules: [],
    }
    m.state.selects.push([draft({ definition: noIdentity, inboxId: "9" })])
    const e = await field(formService.publish({ workspaceId: WS, id: "f1" }))
    expect((e.data as { reason: string }).reason).toBe("noIdentity")
  })

  test("a dangling custom field is refused", async () => {
    m.state.selects.push(
      [draft({ definition: mappedDefinition, inboxId: "9" })],
      [{ id: "9", channel: "api" }],
      [], // custom field 77 no longer exists
    )
    const e = await field(formService.publish({ workspaceId: WS, id: "f1" }))
    expect((e.data as { reason: string }).reason).toBe("danglingCustomField")
  })

  test("copies the draft, bumps the version and stamps publishedAt", async () => {
    m.state.selects.push(
      [
        draft({
          definition: mappedDefinition,
          inboxId: "9",
          definitionVersion: 2,
        }),
      ],
      [{ id: "9", channel: "api" }],
      [{ id: "77" }],
    )
    m.state.updates.push([
      draft({
        status: "published",
        definition: mappedDefinition,
        publishedDefinition: mappedDefinition,
        definitionVersion: 3,
        publishedAt: NOW,
      }),
    ])
    const row = await formService.publish({ workspaceId: WS, id: "f1" })
    expect(row.status).toBe("published")
    expect(row.definitionVersion).toBe(3)
    expect(row.publishedDefinition?.steps).toHaveLength(1)
  })

  test("publish is a 409 when the version or updatedAt moved under it", async () => {
    const anon = {
      steps: [{ id: "s1", fields: [{ key: "q", type: "text" }] }],
      rules: [],
    }
    m.state.selects.push([draft({ definition: anon })])
    m.state.updates.push([])
    const e = await field(formService.publish({ workspaceId: WS, id: "f1" }))
    expect(e.httpStatusCode).toBe(409)
  })

  describe("typed select targets (s201)", () => {
    const choiceDef = (type: string, options: string[]) => ({
      steps: [
        {
          id: "s1",
          fields: [
            {
              key: "phone",
              type: "phone",
              mapTo: { kind: "system", key: "phoneNumber" },
            },
            {
              key: "tier",
              type,
              options: options.map((o) => ({ value: o, label: o })),
              mapTo: { kind: "custom", customFieldId: "77" },
            },
          ],
        },
      ],
      rules: [],
    })
    const publishWith = async (def: unknown, target: unknown) => {
      m.state.selects.push(
        [draft({ definition: def, inboxId: "9" })],
        [{ id: "9", channel: "api" }],
        [target],
      )
      return await field(formService.publish({ workspaceId: WS, id: "f1" }))
    }
    const select = { id: "77", type: "select", options: ["Gold", "Silver"] }
    const multi = { id: "77", type: "multiSelect", options: ["Gold", "Silver"] }

    test("a form option the field does not know is refused", async () => {
      const e = await publishWith(
        choiceDef("radio", ["gold", "Platinum"]),
        select,
      )
      expect(e.data).toMatchObject({
        reason: "mappedOptionsMismatch",
        fieldKey: "tier",
        detail: "unknownOptions",
      })
    })

    test("cardinality must match: radio -> select, checkbox group -> multiSelect", async () => {
      expect(
        (await publishWith(choiceDef("checkboxGroup", ["Gold"]), select)).data,
      ).toMatchObject({ detail: "cardinalityMismatch" })
      expect(
        (await publishWith(choiceDef("radio", ["Gold"]), multi)).data,
      ).toMatchObject({ detail: "cardinalityMismatch" })
    })

    test("a free-text field cannot write to a select field", async () => {
      expect((await publishWith(mappedDefinition, select)).data).toMatchObject({
        reason: "mappedOptionsMismatch",
        detail: "optionFieldRequired",
      })
    })

    test("matching options (case-insensitive) publish", async () => {
      const def = choiceDef("checkboxGroup", ["gold", "SILVER"])
      m.state.selects.push(
        [draft({ definition: def, inboxId: "9" })],
        [{ id: "9", channel: "api" }],
        [multi],
      )
      m.state.updates.push([
        draft({
          status: "published",
          definition: def,
          publishedDefinition: def,
        }),
      ])
      const row = await formService.publish({ workspaceId: WS, id: "f1" })
      expect(row.status).toBe("published")
    })
  })

  test("an anonymous form (no mapping) publishes without an inbox", async () => {
    const anon = {
      steps: [{ id: "s1", fields: [{ key: "q", type: "text" }] }],
      rules: [],
    }
    m.state.selects.push([draft({ definition: anon })])
    m.state.updates.push([
      draft({
        status: "published",
        definition: anon,
        publishedDefinition: anon,
        definitionVersion: 1,
      }),
    ])
    const row = await formService.publish({ workspaceId: WS, id: "f1" })
    expect(row.status).toBe("published")
  })
})

describe("formService reads never throw on corrupt jsonb", () => {
  test("get normalises a garbage definition and settings", async () => {
    m.state.selects.push([
      draft({
        definition: "garbage",
        settings: [1],
        publishedDefinition: { steps: 5 },
      }),
    ])
    const row = await formService.get({ workspaceId: WS, id: "f1" })
    expect(row.definition).toEqual(EMPTY_FORM_DEFINITION)
    expect(row.settings).toEqual(DEFAULT_FORM_SETTINGS)
    expect(row.publishedDefinition).toEqual(EMPTY_FORM_DEFINITION)
  })

  test("findPublishedBySlug: a corrupt published copy fails closed (null)", async () => {
    m.state.selects.push([
      draft({ status: "published", publishedDefinition: "garbage" }),
    ])
    expect(
      await formService.findPublishedBySlug({
        workspaceId: WS,
        slug: "demo-intake",
      }),
    ).toBeNull()
    m.state.selects.push([
      draft({ status: "published", publishedDefinition: { steps: [] } }),
    ])
    expect(
      await formService.findPublishedBySlug({
        workspaceId: WS,
        slug: "demo-intake",
      }),
    ).toBeNull()
  })

  test("findPublishedBySlug: bad slug shape short-circuits, draft -> null", async () => {
    expect(
      await formService.findPublishedBySlug({
        workspaceId: WS,
        slug: "Bad Slug",
      }),
    ).toBeNull()
    expect(m.state.calls).toEqual([])
    m.state.selects.push([])
    expect(
      await formService.findPublishedBySlug({
        workspaceId: WS,
        slug: "demo-intake",
      }),
    ).toBeNull()
  })
})

describe("formService.duplicate", () => {
  test("retries the slug on collision and gives up after five", async () => {
    m.state.selects.push([draft()])
    m.state.insertErrors.push(uniqueError(), uniqueError())
    const row = await formService.duplicate({ workspaceId: WS, id: "f1" })
    expect(row.slug).toBe("demo-intake-copy-3")
    expect(row.status).toBe("draft")
    m.state.selects.push([draft()])
    m.state.insertErrors.push(...Array.from({ length: 5 }, uniqueError))
    const e = await field(formService.duplicate({ workspaceId: WS, id: "f1" }))
    expect(e.field).toBe("slug")
  })
})

describe("submissions", () => {
  test("cursor round-trips and refuses anything it did not issue", () => {
    const c = encodeSubmissionCursor({ k: "1758758400000000", i: "42" })
    expect(decodeSubmissionCursor(c)).toEqual({
      k: "1758758400000000",
      i: "42",
    })
    for (const bad of [
      "not-base64!",
      Buffer.from("[1]").toString("base64url"),
      Buffer.from(JSON.stringify({ k: "1", i: "2", x: 3 })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ k: "2026-09-25", i: "2" })).toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ k: "1", i: "9".repeat(20) })).toString(
        "base64url",
      ),
      "a".repeat(300),
    ]) {
      expect(() => decodeSubmissionCursor(bad), bad).toThrow(CURSOR_RE)
    }
  })

  test("listSubmissions pages by limit + 1 and issues a cursor", async () => {
    m.state.selects.push(
      [draft()],
      [
        { row: { id: "3", createdAt: NOW }, k: "3000" },
        { row: { id: "2", createdAt: NOW }, k: "2000" },
        { row: { id: "1", createdAt: NOW }, k: "1000" },
      ],
    )
    const page = await formService.listSubmissions({
      workspaceId: WS,
      formId: "f1",
      limit: 2,
    })
    expect(page.data.map((r) => r.id)).toEqual(["3", "2"])
    expect(decodeSubmissionCursor(page.nextCursor as string)).toEqual({
      k: "2000",
      i: "2",
    })
    m.state.selects.push(
      [draft()],
      [{ row: { id: "1", createdAt: NOW }, k: "1000" }],
    )
    const last = await formService.listSubmissions({
      workspaceId: WS,
      formId: "f1",
      limit: 2,
      cursor: page.nextCursor,
    })
    expect(last.nextCursor).toBeNull()
  })

  test("submission rows are normalised: corrupt jsonb never reaches the output schema", async () => {
    m.state.selects.push(
      [draft()],
      [
        {
          row: { id: "3", createdAt: NOW, values: "garbage", visibility: null },
          k: "3000",
        },
        {
          row: {
            id: "2",
            createdAt: NOW,
            values: [1],
            visibility: { steps: "x", fields: ["a", 2] },
          },
          k: "2000",
        },
      ],
    )
    const page = await formService.listSubmissions({
      workspaceId: WS,
      formId: "f1",
      limit: 5,
    })
    expect(page.data[0].values).toEqual({})
    expect(page.data[0].visibility).toEqual({ steps: [], fields: [] })
    expect(page.data[1].visibility).toEqual({ steps: [], fields: ["a"] })
    // a non-integer limit falls back to the default instead of reaching SQL
    m.state.selects.push([draft()], [])
    await formService.listSubmissions({
      workspaceId: WS,
      formId: "f1",
      limit: Number.NaN,
    })
    m.state.selects.push([draft()], [])
    await formService.listSubmissions({
      workspaceId: WS,
      formId: "f1",
      limit: 1.5,
    })
  })

  test("delete of an unknown submission -> 404", async () => {
    m.state.deletes.push([])
    const e = await field(
      formService.deleteSubmission({ workspaceId: WS, formId: "f1", id: "9" }),
    )
    expect(e.httpStatusCode).toBe(404)
  })
})
