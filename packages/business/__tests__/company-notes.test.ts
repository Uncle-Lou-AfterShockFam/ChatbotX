import { beforeEach, describe, expect, test, vi } from "vitest"

/**
 * companyNoteService (s195): every write is scoped by workspace AND company,
 * text is validated before any lookup, add / delete log a company activity
 * inside the same transaction, and a missing note is a 404 (never a silent
 * success).
 */
const m = vi.hoisted(() => {
  const state = {
    inserted: [] as Record<string, unknown>[],
    updateReturning: [] as unknown[],
    deleteReturning: [] as unknown[],
    selectRows: [] as unknown[],
    calls: [] as string[],
  }
  const chain = (kind: "update" | "delete" | "select") => {
    const self: Record<string, unknown> = {}
    for (const k of ["set", "where", "from", "orderBy", "limit"]) {
      self[k] = (v: unknown) => {
        if (k === "limit") {
          state.calls.push(`limit:${String(v)}`)
        }
        return self
      }
    }
    self.returning = () =>
      Promise.resolve(
        kind === "update" ? state.updateReturning : state.deleteReturning,
      )
    // biome-ignore lint/suspicious/noThenProperty: awaitable like a drizzle query
    self.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve(state.selectRows).then(ok)
    return self
  }
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v)
        state.calls.push(`insert:${v.type ? "activity" : "note"}`)
        return { returning: () => Promise.resolve([{ ...v }]) }
      },
    }),
    update: () => {
      state.calls.push("update")
      return chain("update")
    },
    delete: () => {
      state.calls.push("delete")
      return chain("delete")
    },
    select: () => {
      state.calls.push("select")
      return chain("select")
    },
    transaction: (cb: (t: unknown) => unknown) => cb(tx),
  }
  return {
    state,
    tx,
    companyFindOrFail: vi.fn(),
    activityRecord: vi.fn((p: Record<string, unknown>) => {
      state.calls.push(`activity:${String(p.type)}`)
      return Promise.resolve(p)
    }),
  }
})

vi.mock("@chatbotx.io/database/client", () => ({
  db: m.tx,
  and: (...c: unknown[]) => ({ c }),
  eq: (f: unknown, v: unknown) => ({ f, v }),
  desc: (f: unknown) => f,
}))
vi.mock("@chatbotx.io/utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createId: () => "note-new",
}))
vi.mock("../src/company/service", () => ({
  companyService: {
    findOrFail: (...a: unknown[]) => m.companyFindOrFail(...a),
  },
}))
vi.mock("../src/company/activity", () => ({
  companyActivityService: {
    record: (...a: unknown[]) => m.activityRecord(...(a as [never])),
  },
}))
vi.mock("../src/audit/dispatcher", () => ({
  dispatchAuditRecord: vi.fn(),
  dispatchAuditRecordSafely: vi.fn(),
}))

import {
  companyNoteService,
  MAX_COMPANY_NOTE_CHARS,
  MAX_COMPANY_NOTES_PAGE,
} from "../src/company/notes"

const WS = "ws-1"
const CO = "co-1"

beforeEach(() => {
  vi.clearAllMocks()
  m.state.inserted.length = 0
  m.state.calls.length = 0
  m.state.updateReturning = []
  m.state.deleteReturning = []
  m.state.selectRows = []
  m.companyFindOrFail.mockResolvedValue({ id: CO, workspaceId: WS })
})

describe("companyNoteService.create", () => {
  test("trims, scopes by workspace + company, logs noteAdded in the tx", async () => {
    const note = await companyNoteService.create({
      workspaceId: WS,
      companyId: CO,
      text: "  Called back  ",
      createdById: "u-1",
    })
    expect(note.text).toBe("Called back")
    expect(m.state.inserted[0]).toMatchObject({
      workspaceId: WS,
      companyId: CO,
      createdById: "u-1",
    })
    expect(m.state.calls).toEqual(["insert:note", "activity:noteAdded"])
    expect(m.activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: CO,
        payload: { noteId: "note-new", excerpt: "Called back" },
      }),
    )
  })

  test.each([
    ["", "empty"],
    ["   ", "blank"],
    [null, "null"],
    [42, "number"],
  ])("rejects %j (%s) before any lookup", async (text) => {
    await expect(
      companyNoteService.create({
        workspaceId: WS,
        companyId: CO,
        text: text as string,
        createdById: null,
      }),
    ).rejects.toMatchObject({ code: "validation" })
    expect(m.companyFindOrFail).not.toHaveBeenCalled()
    expect(m.state.inserted).toHaveLength(0)
  })

  test("over the cap is a 422 (the excerpt is at most 140 chars)", async () => {
    await expect(
      companyNoteService.create({
        workspaceId: WS,
        companyId: CO,
        text: "x".repeat(MAX_COMPANY_NOTE_CHARS + 1),
        createdById: null,
      }),
    ).rejects.toMatchObject({ code: "validation" })
    await companyNoteService.create({
      workspaceId: WS,
      companyId: CO,
      text: "y".repeat(MAX_COMPANY_NOTE_CHARS),
      createdById: null,
    })
    const call = m.activityRecord.mock.calls[0]?.[0] as {
      payload: { excerpt: string }
    }
    expect(call.payload.excerpt).toHaveLength(140)
  })

  test("a company of another workspace is a 404, nothing written", async () => {
    m.companyFindOrFail.mockRejectedValueOnce(
      Object.assign(new Error("Company not found"), { code: "notFound" }),
    )
    await expect(
      companyNoteService.create({
        workspaceId: "ws-other",
        companyId: CO,
        text: "hi",
        createdById: null,
      }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.state.inserted).toHaveLength(0)
  })
})

describe("companyNoteService.update / delete", () => {
  test("update: 0 rows (wrong workspace, company or id) is a 404", async () => {
    m.state.updateReturning = []
    await expect(
      companyNoteService.update({
        workspaceId: WS,
        companyId: CO,
        noteId: "n-x",
        text: "new",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
  })

  test("delete: 0 rows is a 404 and logs nothing; 1 row logs noteDeleted", async () => {
    m.state.deleteReturning = []
    await expect(
      companyNoteService.delete({
        workspaceId: WS,
        companyId: CO,
        noteId: "n-x",
        actorId: "u-1",
      }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.activityRecord).not.toHaveBeenCalled()

    m.state.deleteReturning = [{ id: "n-1" }]
    await companyNoteService.delete({
      workspaceId: WS,
      companyId: CO,
      noteId: "n-1",
      actorId: "u-1",
    })
    expect(m.activityRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "noteDeleted",
        actorId: "u-1",
        payload: { noteId: "n-1" },
      }),
    )
  })
})

describe("companyNoteService.list", () => {
  test("resolves the company first (404 leaks nothing) and caps the page", async () => {
    m.companyFindOrFail.mockRejectedValueOnce(
      Object.assign(new Error("Company not found"), { code: "notFound" }),
    )
    await expect(
      companyNoteService.list({ workspaceId: WS, companyId: "co-other" }),
    ).rejects.toMatchObject({ code: "notFound" })
    expect(m.state.calls).not.toContain("select")

    await companyNoteService.list({
      workspaceId: WS,
      companyId: CO,
      limit: 9999,
    })
    expect(m.state.calls).toContain(`limit:${MAX_COMPANY_NOTES_PAGE}`)
    m.state.calls.length = 0
    await companyNoteService.list({ workspaceId: WS, companyId: CO, limit: 0 })
    expect(m.state.calls).toContain("limit:1")
  })
})
