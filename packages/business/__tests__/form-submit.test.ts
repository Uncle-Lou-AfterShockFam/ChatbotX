import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * The public submit pipeline (s200) at the service seam: every collaborator
 * is a spy, the db is the queue-driven query-builder mock, so each stage's
 * ORDER and its refusal are asserted, not just the happy path.
 */
const m = vi.hoisted(() => {
  const state = {
    selects: [] as unknown[][],
    inserted: [] as Record<string, unknown>[],
    calls: [] as string[],
    txFails: false,
  }
  const chain = () => {
    const self: Record<string, unknown> = {}
    for (const k of ["from", "where", "limit"]) {
      self[k] = () => self
    }
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const next = state.selects.shift()
      return next === undefined
        ? Promise.reject(
            new Error(`mock: no select queued (${state.calls.join(",")})`),
          ).then(ok, ko)
        : Promise.resolve(next).then(ok, ko)
    }
    return self
  }
  const tx = {
    select: () => {
      state.calls.push("select")
      return chain()
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          state.calls.push("insert")
          const row = { ...v, createdAt: new Date(), updatedAt: new Date() }
          state.inserted.push(row)
          return Promise.resolve([row])
        },
      }),
    }),
    execute: vi.fn(() => {
      state.calls.push("execute")
      return Promise.resolve([])
    }),
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      state.calls.push("tx:begin")
      const out = await fn(tx)
      if (state.txFails) {
        state.calls.push("tx:rollback")
        throw new Error("tx failed")
      }
      state.calls.push("tx:commit")
      return out
    },
    query: {
      contactModel: {
        findFirst: vi.fn(async () => undefined as { id: string } | undefined),
      },
    },
  }
  return {
    state,
    tx,
    findPublishedBySlug: vi.fn(),
    findByPhone: vi.fn(async () => undefined as { id: string } | undefined),
    findById: vi.fn(
      async () => undefined as Record<string, unknown> | undefined,
    ),
    setRichSystemFieldByKey: vi.fn(async () => ({})),
    attachContactToInbox: vi.fn(),
    createContactWithInbox: vi.fn(),
    setValuesInTransaction: vi.fn(async () => [
      {
        customFieldId: "77",
        customFieldName: "Size",
        oldValue: null,
        newValue: "L",
      },
    ]),
    emitCustomFieldChanges: vi.fn(async () => undefined),
    attachByNamesToContacts: vi.fn(async () => ({
      processedContactIds: [],
      skippedContactIds: [],
    })),
    emitFormSubmitted: vi.fn(async () => undefined),
    findLatestBySource: vi.fn(
      async () => undefined as { contactId: string } | undefined,
    ),
    workspaceFind: vi.fn(async () => ({ id: "ws", targetCountry: "US" })),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.tx,
  and: (...c: unknown[]) => ({ c }),
  eq: (f: unknown, v: unknown) => ({ f, v }),
  gte: (f: unknown, v: unknown) => ({ gte: [f, v] }),
  inArray: (f: unknown, v: unknown) => ({ in: [f, v] }),
  isUniqueViolationError: (e: unknown) =>
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "23505",
  sql: Object.assign((...a: unknown[]) => ({ sql: a }), { join: () => ({}) }),
}))
vi.mock("@chatbotx.io/database/schema", () => ({
  contactModel: { id: "id" },
  contactCustomFieldModel: {
    contactId: "contactId",
    customFieldId: "customFieldId",
    value: "value",
  },
  formSubmissionModel: {
    id: "id",
    formId: "formId",
    dedupHash: "dedupHash",
    ipHash: "ipHash",
    createdAt: "createdAt",
  },
}))
vi.mock("@chatbotx.io/events", () => ({
  emitFormSubmitted: m.emitFormSubmitted,
}))
vi.mock("../src/form/service", () => ({
  formService: { findPublishedBySlug: m.findPublishedBySlug },
}))
vi.mock("../src/contact/attach-inbox", () => ({
  attachContactToInbox: m.attachContactToInbox,
}))
vi.mock("../src/contact/create-with-inbox", () => ({
  createContactWithInbox: m.createContactWithInbox,
  resolveDefaultRegion: (c: string | null | undefined) =>
    c && c !== "unknown" ? c : undefined,
}))
vi.mock("../src/contact/service", () => ({
  contactService: {
    findByPhone: m.findByPhone,
    findById: m.findById,
    setRichSystemFieldByKey: m.setRichSystemFieldByKey,
  },
}))
vi.mock("../src/contact-custom-field/service", () => ({
  contactCustomFieldService: {
    setValuesInTransaction: m.setValuesInTransaction,
    emitCustomFieldChanges: m.emitCustomFieldChanges,
  },
}))
vi.mock("../src/contact-inbox/service", () => ({
  contactInboxService: { findLatestBySource: m.findLatestBySource },
}))
vi.mock("../src/tag/service", () => ({
  tagService: { attachByNamesToContacts: m.attachByNamesToContacts },
}))
vi.mock("../src/workspace/service", () => ({
  workspaceService: { find: m.workspaceFind },
}))
vi.mock("../src/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: (() => {
    let n = 0
    return () => `sub-${++n}`
  })(),
}))

import { ChatbotXException } from "../src/errors"
import {
  FORM_DEDUP_WINDOW_SECONDS,
  formSubmitService,
  hashClientIp,
} from "../src/form/submit"

const SUB_ID_RE = /^sub-\d+$/
const WS = "11701868563365888"
const NOW = new Date("2026-09-25T17:00:00Z")
const DEF = {
  steps: [
    {
      id: "s1",
      fields: [
        {
          key: "first_name",
          type: "text",
          required: false,
          label: "",
          mapTo: { kind: "system", key: "firstName" },
        },
        {
          key: "phone",
          type: "phone",
          required: false,
          label: "",
          mapTo: { kind: "system", key: "phoneNumber" },
        },
        {
          key: "email",
          type: "email",
          required: false,
          label: "",
          mapTo: { kind: "system", key: "email" },
        },
        {
          key: "size",
          type: "select",
          required: false,
          label: "",
          options: [
            { value: "L", label: "L" },
            { value: "M", label: "M" },
          ],
          mapTo: { kind: "custom", customFieldId: "77" },
        },
        {
          key: "interest",
          type: "select",
          required: false,
          label: "",
          options: [
            { value: "none", label: "None" },
            { value: "other", label: "Other" },
          ],
        },
        {
          key: "other",
          type: "text",
          required: false,
          label: "",
          visibleWhen: {
            logic: "AND",
            rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
          },
        },
      ],
    },
  ],
  rules: [
    {
      id: "r1",
      when: {
        logic: "AND",
        rules: [{ fieldKey: "interest", op: "eq", value: "other" }],
      },
      action: { type: "require", fieldKey: "other" },
    },
  ],
}
const FORM = (over: Record<string, unknown> = {}) => ({
  id: "form-1",
  workspaceId: WS,
  slug: "demo-intake",
  status: "published",
  definitionVersion: 2,
  inboxId: "inbox-9",
  publishedDefinition: DEF,
  settings: {
    successMessage: "Thanks!",
    redirectUrl: null,
    tags: ["lead"],
    honeypot: true,
    submitLimitPerIpPerHour: 3,
    embedOrigins: [],
    prefillKeys: [],
    overwriteExisting: false,
  },
  ...over,
})
const submit = (values: unknown, over: Record<string, unknown> = {}) =>
  formSubmitService.submit({
    workspaceId: WS,
    slug: "demo-intake",
    values,
    honeypotFilled: false,
    clientIp: "203.0.113.9",
    userAgent: "vitest",
    now: NOW,
    ...over,
  })

beforeEach(() => {
  vi.clearAllMocks()
  m.state.selects.length = 0
  m.state.inserted.length = 0
  m.state.calls.length = 0
  m.state.txFails = false
  m.findPublishedBySlug.mockResolvedValue(FORM())
  m.findByPhone.mockResolvedValue(undefined)
  m.tx.query.contactModel.findFirst.mockResolvedValue(undefined)
  m.createContactWithInbox.mockResolvedValue({
    contact: { id: "c-new" },
    contactInbox: { id: "ci" },
  })
  m.attachContactToInbox.mockResolvedValue({
    contactInbox: { contactId: "c-old" },
    ownedByAnotherContact: false,
    created: true,
  })
})

/** dedup miss, budget count, in-tx dedup re-check (miss) */
const queueClean = (used = 0) => m.state.selects.push([], [{ count: used }], [])

describe("formSubmitService.submit (s200)", () => {
  test("unknown / unpublished slug -> notFound before anything else", async () => {
    m.findPublishedBySlug.mockResolvedValue(null)
    expect(await submit({})).toEqual({ kind: "notFound" })
    expect(m.state.calls).toEqual([])
  })

  test("honeypot filled -> ok, ZERO rows, no contact, no events", async () => {
    const r = await submit({ first_name: "bot" }, { honeypotFilled: true })
    expect(r.kind).toBe("ok")
    expect(m.state.inserted).toHaveLength(0)
    expect(m.state.calls).toEqual([])
    expect(m.emitFormSubmitted).not.toHaveBeenCalled()
  })

  test("a non-object body and a wrong-typed / out-of-option answer are invalid, nothing persisted", async () => {
    expect(await submit([1])).toEqual({
      kind: "invalid",
      issues: [{ key: "values", code: "type" }],
    })
    expect(await submit("x")).toMatchObject({ kind: "invalid" })
    const r = await submit({ size: "XL" })
    expect(r).toEqual({
      kind: "invalid",
      issues: [{ key: "size", code: "option" }],
    })
    const req = await submit({ interest: "other" })
    expect(req).toEqual({
      kind: "invalid",
      issues: [{ key: "other", code: "required" }],
    })
    expect(m.state.calls).toEqual([])
  })

  test("a value for a HIDDEN field is dropped, not an error; unknown keys are dropped", async () => {
    queueClean()
    const r = await submit({
      interest: "none",
      other: "stale",
      bogus: "x",
      first_name: "Ada",
      phone: "+12154075123",
    })
    expect(r.kind).toBe("ok")
    expect(m.state.inserted[0].values).toEqual({
      interest: "none",
      first_name: "Ada",
      phone: "+12154075123",
    })
    expect(m.state.inserted[0].visibility).toEqual({
      steps: ["s1"],
      fields: ["first_name", "phone", "email", "size", "interest"],
    })
  })

  test("dedup: an identical resubmit inside the window returns the first row, no insert, no events", async () => {
    m.state.selects.push([{ id: "sub-old", contactId: "c-old" }])
    const r = await submit({ first_name: "Ada" })
    expect(r).toMatchObject({
      kind: "ok",
      duplicate: true,
      submissionId: "sub-old",
    })
    expect(m.state.inserted).toHaveLength(0)
    expect(m.emitFormSubmitted).not.toHaveBeenCalled()
    expect(FORM_DEDUP_WINDOW_SECONDS).toBe(300)
  })

  test("budget: the per-form-per-ip hourly limit refuses with a Retry-After, nothing persisted", async () => {
    m.state.selects.push([], [{ count: 3 }])
    const r = await submit({ first_name: "Ada" })
    expect(r).toEqual({ kind: "rateLimited", retryAfter: 3600 })
    expect(m.state.inserted).toHaveLength(0)
  })

  test("anonymous submission (no identity answer): stored without a contact, no write-back, no event", async () => {
    queueClean()
    const r = await submit({ first_name: "Ada", size: "L" })
    expect(r).toMatchObject({ kind: "ok", contactId: null })
    expect(m.state.inserted[0].contactId).toBeNull()
    expect(m.setRichSystemFieldByKey).not.toHaveBeenCalled()
    expect(m.setValuesInTransaction).not.toHaveBeenCalled()
    expect(m.attachByNamesToContacts).not.toHaveBeenCalled()
    expect(m.emitFormSubmitted).not.toHaveBeenCalled()
  })

  test("an invalid phone answer is a typed 'phone' issue on that field", async () => {
    queueClean()
    const r = await submit({ phone: "12" })
    expect(r).toEqual({
      kind: "invalid",
      issues: [{ key: "phone", code: "phone" }],
    })
  })

  test("new contact: created on the form's API inbox with E.164 phone, then fields, tags and the event AFTER commit", async () => {
    queueClean()
    const r = await submit({
      first_name: "Ada",
      phone: "(215) 407-5123",
      email: "ADA@Example.com",
      size: "L",
    })
    expect(r).toMatchObject({
      kind: "ok",
      contactId: "c-new",
      duplicate: false,
    })
    expect(m.createContactWithInbox).toHaveBeenCalledWith({
      workspaceId: WS,
      input: {
        email: "ada@example.com",
        phoneNumber: "+12154075123",
        firstName: "Ada",
        lastName: undefined,
        gender: null,
        channel: "api",
        inboxId: "inbox-9",
        contactId: "+12154075123",
      },
    })
    // write-back inside the tx: system fields + custom fields (non-blank only)
    expect(m.setRichSystemFieldByKey).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldName: "first_name",
        value: "Ada",
        contactId: "c-new",
      }),
    )
    expect(m.setValuesInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "c-new",
        fields: [{ customFieldId: "77", value: "L" }],
      }),
      m.tx,
    )
    // after commit, in order: custom-field events, tags, formSubmitted
    const commitAt = m.state.calls.indexOf("tx:commit")
    expect(commitAt).toBeGreaterThan(-1)
    expect(m.emitCustomFieldChanges).toHaveBeenCalledWith({
      workspaceId: WS,
      contactId: "c-new",
      changes: expect.any(Array),
    })
    expect(m.attachByNamesToContacts).toHaveBeenCalledWith({
      workspaceId: WS,
      contactIds: ["c-new"],
      names: ["lead"],
    })
    expect(m.emitFormSubmitted).toHaveBeenCalledWith(WS, "c-new", {
      formId: "form-1",
      formSlug: "demo-intake",
      submissionId: expect.stringMatching(SUB_ID_RE),
      definitionVersion: 2,
      // the event carries the answers AS GIVEN; normalisation happens on the contact
      values: {
        first_name: "Ada",
        phone: "(215) 407-5123",
        email: "ADA@Example.com",
        size: "L",
      },
    })
    expect(m.state.inserted[0]).toMatchObject({
      contactId: "c-new",
      definitionVersion: 2,
      dedupHash: expect.any(String),
      ipHash: hashClientIp(WS, "203.0.113.9"),
    })
  })

  test("existing contact by phone: attached with onConflict resolve; the OWNER wins when another contact holds the identity", async () => {
    queueClean()
    m.state.selects.push([]) // stored custom values of the owner: none
    m.findById.mockResolvedValue({ id: "c-owner", firstName: null })
    m.findByPhone.mockResolvedValue({ id: "c-old" })
    m.attachContactToInbox.mockResolvedValue({
      contactInbox: { contactId: "c-owner" },
      ownedByAnotherContact: true,
      created: false,
    })
    const r = await submit({ phone: "+12154075123", first_name: "Ada" })
    expect(r).toMatchObject({ kind: "ok", contactId: "c-owner" })
    expect(m.attachContactToInbox).toHaveBeenCalledWith({
      workspaceId: WS,
      contactId: "c-old",
      inboxId: "inbox-9",
      sourceId: "+12154075123",
      onConflict: "resolve",
    })
    expect(m.createContactWithInbox).not.toHaveBeenCalled()
    expect(m.setRichSystemFieldByKey).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c-owner" }),
    )
  })

  test("existing contact found by email when no phone; a blank answer never clears a stored value", async () => {
    queueClean()
    m.state.selects.push([])
    m.findById.mockResolvedValue({ id: "c-mail", email: null })
    m.tx.query.contactModel.findFirst.mockResolvedValue({ id: "c-mail" })
    m.attachContactToInbox.mockResolvedValue({
      contactInbox: { contactId: "c-mail" },
      ownedByAnotherContact: false,
      created: true,
    })
    const r = await submit({ email: "a@b.co", first_name: "", size: "" })
    expect(r).toMatchObject({ kind: "ok", contactId: "c-mail" })
    expect(m.attachContactToInbox).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: "c-mail", sourceId: "a@b.co" }),
    )
    const written = m.setRichSystemFieldByKey.mock.calls.map(
      (c) => (c[0] as { fieldName: string }).fieldName,
    )
    expect(written).toEqual(["email"])
    expect(m.setValuesInTransaction).not.toHaveBeenCalled()
  })

  test("owner without a DM conversation (409 from attach): the owner is looked up and written to", async () => {
    queueClean()
    m.state.selects.push([])
    m.findById.mockResolvedValue({ id: "c-owner2" })
    m.findByPhone.mockResolvedValue({ id: "c-old" })
    m.attachContactToInbox.mockRejectedValue(
      new ChatbotXException("owned", "contactInboxOwnedByAnotherContact", 409),
    )
    m.findLatestBySource.mockResolvedValue({ contactId: "c-owner2" })
    const r = await submit({ phone: "+12154075123" })
    expect(r).toMatchObject({ kind: "ok", contactId: "c-owner2" })
  })

  test("a transaction failure rolls everything back: no events, no tags", async () => {
    queueClean()
    m.state.selects.push([])
    m.findById.mockResolvedValue({ id: "c-new" })
    m.state.txFails = true
    await expect(submit({ phone: "+12154075123" })).rejects.toThrow("tx failed")
    expect(m.emitFormSubmitted).not.toHaveBeenCalled()
    expect(m.attachByNamesToContacts).not.toHaveBeenCalled()
    expect(m.emitCustomFieldChanges).not.toHaveBeenCalled()
  })

  test("an after-commit failure is logged, the response is still ok", async () => {
    queueClean()
    m.emitFormSubmitted.mockRejectedValue(new Error("queue down"))
    m.attachByNamesToContacts.mockRejectedValue(new Error("tags down"))
    const r = await submit({ phone: "+12154075123" })
    expect(r.kind).toBe("ok")
  })

  test("a form that maps nothing never touches contacts, even with a phone-looking answer", async () => {
    m.findPublishedBySlug.mockResolvedValue(
      FORM({
        inboxId: null,
        publishedDefinition: {
          steps: [
            {
              id: "s1",
              fields: [{ key: "q", type: "text", required: false, label: "" }],
            },
          ],
          rules: [],
        },
      }),
    )
    queueClean()
    const r = await submit({ q: "+12154075123" })
    expect(r).toMatchObject({ kind: "ok", contactId: null })
    expect(m.findByPhone).not.toHaveBeenCalled()
  })

  test("an EXISTING contact keeps its stored values: only blanks are filled (skeptic, s200)", async () => {
    queueClean()
    m.findByPhone.mockResolvedValue({ id: "c-old" })
    m.attachContactToInbox.mockResolvedValue({
      contactInbox: { contactId: "c-old" },
      ownedByAnotherContact: false,
      created: false,
    })
    m.findById.mockResolvedValue({
      id: "c-old",
      firstName: "Stored",
      email: "kept@x.io",
      phoneNumber: "+12154075123",
    })
    m.state.selects.push([{ customFieldId: "77", value: "M" }]) // size already stored
    const r = await submit({
      phone: "+12154075123",
      first_name: "Attacker",
      email: "evil@x.io",
      size: "L",
    })
    expect(r).toMatchObject({ kind: "ok", contactId: "c-old" })
    expect(m.setRichSystemFieldByKey).not.toHaveBeenCalled()
    expect(m.setValuesInTransaction).not.toHaveBeenCalled()
  })

  test("with overwriteExisting on, an existing contact's values are replaced", async () => {
    m.findPublishedBySlug.mockResolvedValue(
      FORM({ settings: { ...FORM().settings, overwriteExisting: true } }),
    )
    queueClean()
    m.findByPhone.mockResolvedValue({ id: "c-old" })
    m.attachContactToInbox.mockResolvedValue({
      contactInbox: { contactId: "c-old" },
      ownedByAnotherContact: false,
      created: false,
    })
    await submit({ phone: "+12154075123", first_name: "New" })
    expect(m.findById).not.toHaveBeenCalled()
    expect(m.setRichSystemFieldByKey).toHaveBeenCalledWith(
      expect.objectContaining({ fieldName: "first_name", value: "New" }),
    )
  })

  test("a create race (the other submit won) resolves to the winner, never an error", async () => {
    queueClean()
    m.state.selects.push([])
    m.findById.mockResolvedValue({ id: "c-winner" })
    m.findByPhone
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: "c-winner" })
    m.createContactWithInbox.mockRejectedValue(
      new ChatbotXException("Phone number is exists", "validation", 422),
    )
    const r = await submit({ phone: "+12154075123", first_name: "Ada" })
    expect(r).toMatchObject({ kind: "ok", contactId: "c-winner" })
  })

  test("the transaction takes an advisory lock and re-checks dedup before inserting", async () => {
    m.state.selects.push(
      [],
      [{ count: 0 }],
      [{ id: "sub-race", contactId: null }],
    ) // in-tx re-check finds the racer's row
    const r = await submit({ first_name: "Ada" })
    expect(r).toMatchObject({
      kind: "ok",
      duplicate: true,
      submissionId: "sub-race",
    })
    expect(m.state.calls).toContain("execute")
    expect(m.state.inserted).toHaveLength(0)
    expect(m.emitFormSubmitted).not.toHaveBeenCalled()
  })

  test("the same answers from another ip are NOT a duplicate (ip is in the hash)", () => {
    expect(hashClientIp(WS, "1.1.1.1")).not.toBe(hashClientIp(WS, "2.2.2.2"))
    expect(hashClientIp(WS, "1.1.1.1")).toHaveLength(64)
  })
})
