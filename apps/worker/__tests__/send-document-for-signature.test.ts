import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  findByIdOrFail: vi.fn(),
  resolveByNameAndType: vi.fn(),
  setValueByKey: vi.fn(),
  sendForSignature: vi.fn(),
  contactDocumentVariables: vi.fn(() => async () => ({})),
}))

vi.mock("@chatbotx.io/business", () => ({
  contactService: { findByIdOrFail: mocks.findByIdOrFail },
  customFieldService: { resolveByNameAndType: mocks.resolveByNameAndType },
  contactCustomFieldService: { setValueByKey: mocks.setValueByKey },
}))
vi.mock("@chatbotx.io/business/documents", () => ({
  documentSigningService: { sendForSignature: mocks.sendForSignature },
  SIG_LINK_FIELD: "sig_link",
  SIG_DOC_ID_FIELD: "sig_doc_id",
}))
vi.mock("@chatbotx.io/variables", () => ({
  contactDocumentVariables: mocks.contactDocumentVariables,
}))
vi.mock("../src/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const { handleSendDocumentForSignature, signatureRef } = await import(
  "../src/integration/handlers/send-document-for-signature"
)

const SIG_REF_REGEX = /^sig:[0-9a-f]{40}$/

type Props = Parameters<typeof handleSendDocumentForSignature>[0]
const props = (
  over: Partial<Props> = {},
  templateId: string | undefined = "t1",
) =>
  ({
    conversation: { id: "conv-1", workspaceId: "w1", contactId: "c1" },
    contactInbox: { id: "ci-1", inboxId: "in-1", channel: "api" },
    step: {
      id: "step-1",
      stepType: "sendDocumentForSignature",
      templateId,
      states: [],
    },
    flowExecutionKey: "flow-run-1",
    ...over,
  }) as unknown as Props

beforeEach(() => {
  vi.clearAllMocks()
  mocks.findByIdOrFail.mockResolvedValue({
    id: "c1",
    fullName: " Ada Lovelace ",
  })
  mocks.resolveByNameAndType.mockResolvedValue({
    idMap: new Map([
      ["shortText:sig_link", "111"],
      ["shortText:sig_doc_id", "222"],
    ]),
  })
  mocks.setValueByKey.mockResolvedValue(undefined)
  mocks.sendForSignature.mockResolvedValue({
    ok: true,
    reused: false,
    document: { id: "d1" },
    signingUrl: "https://sig/s/tok",
    documensoDocumentId: 42,
  })
})

describe("signatureRef", () => {
  test("stable per (run, step), ref-safe, and distinct across runs and steps", () => {
    const a = signatureRef("flow-run-1", "step-1")
    expect(a).toBe(signatureRef("flow-run-1", "step-1"))
    expect(a).toMatch(SIG_REF_REGEX)
    expect(a).not.toBe(signatureRef("flow-run-2", "step-1"))
    expect(a).not.toBe(signatureRef("flow-run-1", "step-2"))
    // The encoding keeps ("ab","c") and ("a","bc") apart, NUL included.
    expect(signatureRef("ab", "c")).not.toBe(signatureRef("a", "bc"))
    expect(signatureRef("a\u0000b", "c")).not.toBe(
      signatureRef("a", "b\u0000c"),
    )
  })
})

describe("handleSendDocumentForSignature", () => {
  test("no template picked: error edge, nothing sent", async () => {
    const r = await handleSendDocumentForSignature(props({}, ""))
    expect(r).toMatchObject({
      status: "error",
      errorMessage: "No document template picked",
    })
    expect(mocks.sendForSignature).not.toHaveBeenCalled()
  })

  test("no run key: refused (a retry would open a second document)", async () => {
    const r = await handleSendDocumentForSignature(
      props({ flowExecutionKey: undefined }),
    )
    expect(r.status).toBe("error")
    expect(mocks.sendForSignature).not.toHaveBeenCalled()
  })

  test("success: signs as the contact, writes sig_link + sig_doc_id on the conversation's inbox", async () => {
    const r = await handleSendDocumentForSignature(props())
    expect(r).toEqual({
      status: "success",
      result: { documentId: "d1", documensoDocumentId: 42, reused: false },
    })
    expect(mocks.sendForSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        contactId: "c1",
        templateId: "t1",
        ref: signatureRef("flow-run-1", "step-1"),
        signerName: "Ada Lovelace",
      }),
    )
    expect(mocks.contactDocumentVariables).toHaveBeenCalledWith("c1")
    expect(mocks.setValueByKey.mock.calls.map((c) => c[0])).toEqual([
      {
        workspaceId: "w1",
        contactId: "c1",
        keyword: "111",
        value: "https://sig/s/tok",
        contactInboxId: "ci-1",
      },
      {
        workspaceId: "w1",
        contactId: "c1",
        keyword: "222",
        value: "42",
        contactInboxId: "ci-1",
      },
    ])
  })

  test("a huge contact name is capped before it reaches Documenso", async () => {
    mocks.findByIdOrFail.mockResolvedValue({
      id: "c1",
      fullName: "x".repeat(10_000),
    })
    await handleSendDocumentForSignature(props())
    expect(mocks.sendForSignature.mock.calls[0][0].signerName).toHaveLength(100)
  })

  test("a nameless contact signs as Signer", async () => {
    mocks.findByIdOrFail.mockResolvedValue({ id: "c1", fullName: null })
    await handleSendDocumentForSignature(props())
    expect(mocks.sendForSignature.mock.calls[0][0].signerName).toBe("Signer")
  })

  test("a failure value takes the error edge with its stage; no fields written", async () => {
    mocks.sendForSignature.mockResolvedValue({
      ok: false,
      stage: "verify",
      error: "no signature field",
    })
    const r = await handleSendDocumentForSignature(props())
    expect(r).toEqual({
      status: "error",
      errorMessage: "verify: no signature field",
      result: null,
    })
    expect(mocks.setValueByKey).not.toHaveBeenCalled()
  })

  test("a throw (contact gone, DB error) is an error edge, never an unhandled rejection", async () => {
    mocks.findByIdOrFail.mockRejectedValue(new Error("Contact not found"))
    const r = await handleSendDocumentForSignature(props())
    expect(r).toEqual({
      status: "error",
      errorMessage: "Contact not found",
      result: null,
    })
  })
})
