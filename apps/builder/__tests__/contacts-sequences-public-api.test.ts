import { beforeEach, describe, expect, test, vi } from "vitest"

type RouteConfig = {
  method: string
  path: string
  summary: string
  tags: string[]
  successStatus?: number
}

type CapturedProcedure = {
  route: RouteConfig
  handler?: (...args: any[]) => any
}

const { workspaceTokenAuthAPIForScope, capturedProcedures } = vi.hoisted(() => {
  const capturedProcedures: CapturedProcedure[] = []

  const makeProcedure = (route: RouteConfig) => {
    const record: CapturedProcedure = { route }
    capturedProcedures.push(record)

    const chain = {
      input: vi.fn(() => chain),
      output: vi.fn(() => chain),
      errors: vi.fn(() => chain),
      handler: vi.fn((fn: (...args: any[]) => any) => {
        record.handler = fn
        return { handler: fn }
      }),
    }
    return chain
  }

  const workspaceTokenAuthAPI = {
    route: vi.fn((config: RouteConfig) => makeProcedure(config)),
  }

  return {
    workspaceTokenAuthAPIForScope: vi.fn(
      (_scope: string) => workspaceTokenAuthAPI,
    ),
    capturedProcedures,
  }
})

vi.mock("@/orpc", () => ({ workspaceTokenAuthAPIForScope }))

const contactSequenceService = {
  listByContactId: vi.fn(),
  removeContactSequencesForContacts: vi.fn(),
  updateContactSequences: vi.fn(),
  resumeHeldEnrollment: vi.fn(),
  reactivateEnrollment: vi.fn(),
}

const resolveContactId = vi.fn()

const subscribeContactsToSequences = vi.fn()

vi.mock("@chatbotx.io/business", () => ({
  contactService: { resolveIdByIdentifier: resolveContactId },
}))
vi.mock("@chatbotx.io/business/contact-sequence", () => ({
  contactSequenceService: {
    ...contactSequenceService,
    subscribeContacts: subscribeContactsToSequences,
  },
}))

await import("@/features/contact-sequences/api/public")

const findProcedure = (method: string, path: string) => {
  const found = capturedProcedures.find(
    (p) => p.route.method === method && p.route.path === path,
  )
  if (!found) {
    throw new Error(`No procedure registered for ${method} ${path}`)
  }
  return found
}

beforeEach(() => {
  vi.clearAllMocks()
  resolveContactId.mockResolvedValue("contact-1")
})

describe("GET /v1/contacts/{identifier}/sequences", () => {
  const procedure = findProcedure("GET", "/v1/contacts/{identifier}/sequences")

  test("lists every subscription, ENDED ones included (s228b), with ISO dates", async () => {
    const enrolledAt = new Date("2026-09-30T08:00:00.000Z")
    const endedAt = new Date("2026-09-30T09:00:00.000Z")
    contactSequenceService.listByContactId.mockResolvedValueOnce([
      {
        sequenceId: "seq-1",
        sequenceName: "Welcome",
        status: "ended",
        lastError: null,
        enrolledAt,
        completedAt: null,
        endedAt,
        endReason: "contact_replied",
        replyState: "replied",
        repliedAt: endedAt,
        pausedUntil: null,
        currentStep: 1,
        updatedAt: endedAt,
      },
    ])

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:123" },
      }),
    ).resolves.toEqual({
      data: [
        {
          sequenceId: "seq-1",
          sequenceName: "Welcome",
          status: "ended",
          lastError: null,
          enrolledAt: "2026-09-30T08:00:00.000Z",
          completedAt: null,
          endedAt: "2026-09-30T09:00:00.000Z",
          endReason: "contact_replied",
          replyState: "replied",
          repliedAt: "2026-09-30T09:00:00.000Z",
          pausedUntil: null,
          currentStep: 1,
          updatedAt: "2026-09-30T09:00:00.000Z",
        },
      ],
    })

    expect(contactSequenceService.listByContactId).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      includeEnded: true,
    })
  })
})

describe("POST /v1/contacts/{identifier}/sequences", () => {
  const procedure = findProcedure("POST", "/v1/contacts/{identifier}/sequences")

  test("subscribes the single resolved contact to the given sequences", async () => {
    subscribeContactsToSequences.mockResolvedValueOnce(undefined)

    await procedure.handler?.({
      context: { workspace: { id: "workspace-1" } },
      input: { identifier: "id:123", sequenceIds: ["seq-1", "seq-2"] },
    })

    expect(subscribeContactsToSequences).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactIds: ["contact-1"],
      sequenceIds: ["seq-1", "seq-2"],
    })
  })
})

describe("DELETE /v1/contacts/{identifier}/sequences", () => {
  const procedure = findProcedure(
    "DELETE",
    "/v1/contacts/{identifier}/sequences",
  )

  test("removes the subscription with reason subscription_removed", async () => {
    contactSequenceService.removeContactSequencesForContacts.mockResolvedValueOnce(
      [],
    )

    await procedure.handler?.({
      context: { workspace: { id: "workspace-1" } },
      input: { identifier: "id:123", sequenceIds: ["seq-1"] },
    })

    expect(
      contactSequenceService.removeContactSequencesForContacts,
    ).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactIds: ["contact-1"],
      sequenceIds: ["seq-1"],
      reason: "subscription_removed",
    })
  })
})

describe("PUT /v1/contacts/{identifier}/sequences", () => {
  const procedure = findProcedure("PUT", "/v1/contacts/{identifier}/sequences")

  test("replaces subscriptions via updateContactSequences", async () => {
    contactSequenceService.updateContactSequences.mockResolvedValueOnce({})

    await procedure.handler?.({
      context: { workspace: { id: "workspace-1" } },
      input: { identifier: "id:123", sequenceIds: ["seq-3"] },
    })

    expect(contactSequenceService.updateContactSequences).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      sequenceIds: ["seq-3"],
    })
  })
})

describe("POST /v1/contacts/{identifier}/sequences/{sequenceId}/resume (s227b)", () => {
  const procedure = findProcedure(
    "POST",
    "/v1/contacts/{identifier}/sequences/{sequenceId}/resume",
  )

  test("resumes the resolved contact's held subscription in this workspace", async () => {
    contactSequenceService.resumeHeldEnrollment.mockResolvedValueOnce({
      runAt: new Date("2026-10-01T09:00:00.000Z"),
    })

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:123", sequenceId: "seq-1" },
      }),
    ).resolves.toEqual({ runAt: "2026-10-01T09:00:00.000Z" })

    expect(contactSequenceService.resumeHeldEnrollment).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      sequenceId: "seq-1",
    })
  })

  test("a not-held subscription's 409 propagates", async () => {
    const conflict = Object.assign(new Error("not held"), {
      httpStatusCode: 409,
    })
    contactSequenceService.resumeHeldEnrollment.mockRejectedValueOnce(conflict)

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: { identifier: "id:123", sequenceId: "seq-1" },
      }),
    ).rejects.toBe(conflict)
  })
})

describe("POST /v1/contacts/{identifier}/sequences/{sequenceId}/reactivate (s228b)", () => {
  const procedure = findProcedure(
    "POST",
    "/v1/contacts/{identifier}/sequences/{sequenceId}/reactivate",
  )

  test("reactivates the resolved contact's ended subscription with the optimistic check", async () => {
    contactSequenceService.reactivateEnrollment.mockResolvedValueOnce({
      runAt: new Date("2026-10-01T09:00:00.000Z"),
    })

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: {
          identifier: "id:123",
          sequenceId: "seq-1",
          expectedUpdatedAt: "2026-09-30T09:00:00.000Z",
        },
      }),
    ).resolves.toEqual({ runAt: "2026-10-01T09:00:00.000Z" })

    expect(contactSequenceService.reactivateEnrollment).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      sequenceId: "seq-1",
      expectedUpdatedAt: new Date("2026-09-30T09:00:00.000Z"),
    })
  })

  test("no active step left = runAt null", async () => {
    contactSequenceService.reactivateEnrollment.mockResolvedValueOnce({
      runAt: null,
    })

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: {
          identifier: "id:123",
          sequenceId: "seq-1",
          expectedUpdatedAt: "2026-09-30T09:00:00.000Z",
        },
      }),
    ).resolves.toEqual({ runAt: null })
  })

  test("a 409 (changed / not reactivatable) propagates", async () => {
    const conflict = Object.assign(new Error("changed"), {
      httpStatusCode: 409,
    })
    contactSequenceService.reactivateEnrollment.mockRejectedValueOnce(conflict)

    await expect(
      procedure.handler?.({
        context: { workspace: { id: "workspace-1" } },
        input: {
          identifier: "id:123",
          sequenceId: "seq-1",
          expectedUpdatedAt: "2026-09-30T09:00:00.000Z",
        },
      }),
    ).rejects.toBe(conflict)
  })
})
