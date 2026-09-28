import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  checkSsrfSafety: vi.fn(async () => ({
    unsafe: false,
    resolvedIps: ["93.184.216.34"],
  })),
  findByIdOrFail: vi.fn(async () => ({ id: "contact-1", firstName: "Ada" })),
  listValues: vi.fn(async () => [{ customFieldId: "field-1", value: "x" }]),
  setValues: vi.fn(async () => undefined),
}))

// s216: requests go through the SSRF-pinned outboundFetch (its redirect and
// connect-time checks are covered by net-node-pinned-fetch.test.ts); here it
// forwards to the stubbed global fetch so the request shape stays visible.
vi.mock("../src/net/outbound-fetch", () => ({
  outboundFetch: (...args: unknown[]) =>
    (globalThis.fetch as (...a: unknown[]) => Promise<Response>)(...args),
}))

vi.mock("../src/net/ssrf-guard", () => ({
  checkSsrfSafety: mocks.checkSsrfSafety,
}))

vi.mock("../src/contact/service", () => ({
  contactService: { findByIdOrFail: mocks.findByIdOrFail },
}))

vi.mock("../src/contact-custom-field/service", () => ({
  contactCustomFieldService: {
    listValues: mocks.listValues,
    setValues: mocks.setValues,
  },
}))

const { externalRequestService } = await import(
  "../src/external-request/service"
)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkSsrfSafety.mockResolvedValue({
    unsafe: false,
    resolvedIps: ["93.184.216.34"],
  })
  mocks.findByIdOrFail.mockResolvedValue({ id: "contact-1", firstName: "Ada" })
  mocks.listValues.mockResolvedValue([{ customFieldId: "field-1", value: "x" }])
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("externalRequestService.execute", () => {
  test("throws when the URL is SSRF-unsafe, without calling fetch", async () => {
    mocks.checkSsrfSafety.mockResolvedValue({ unsafe: true })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      externalRequestService.execute(
        { method: "GET", url: "http://169.254.169.254/", headers: [] },
        { workspaceId: "workspace-1" },
      ),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    ["unsafeRedirect", "This URL is not allowed for external requests"],
    ["unsafeAddress", "This URL is not allowed for external requests"],
    ["tooManyRedirects", "Too many redirects"],
  ] as const)("a pinned-fetch refusal (%s) keeps the ssrfBlocked error", async (reason, message) => {
    const { SsrfFetchError } = await import("../src/net/safe-fetch")
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.reject(new SsrfFetchError(reason, "https://api.example.com")),
      ),
    )

    await expect(
      externalRequestService.execute(
        { method: "GET", url: "https://api.example.com/data", headers: [] },
        { workspaceId: "workspace-1" },
      ),
    ).rejects.toMatchObject({
      code: "ssrfBlocked",
      message: expect.stringContaining(message),
    })
  })

  test("a response over the cap is refused, not buffered (s216)", async () => {
    const { EXTERNAL_RESPONSE_MAX_BYTES } = await import(
      "../src/external-request/service"
    )
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array(EXTERNAL_RESPONSE_MAX_BYTES + 1), {
            status: 200,
          }),
      ),
    )

    await expect(
      externalRequestService.execute(
        { method: "GET", url: "https://api.example.com/data", headers: [] },
        { workspaceId: "workspace-1" },
      ),
    ).rejects.toMatchObject({ code: "responseTooLarge" })
  })

  test("GET builds a request with no body", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await externalRequestService.execute(
      { method: "GET", url: "https://api.example.com/data", headers: [] },
      { workspaceId: "workspace-1" },
    )

    const [url, init, options] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
      { maxRedirects: number; timeoutMs: number },
    ]
    expect(url).toBe("https://api.example.com/data")
    expect(init.method).toBe("GET")
    expect(init.body).toBeUndefined()
    expect(options).toEqual({ maxRedirects: 5, timeoutMs: 15_000 })
  })

  test("POST with json body sets Content-Type: application/json", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await externalRequestService.execute(
      {
        method: "POST",
        url: "https://api.example.com/data",
        headers: [],
        body: { bodyType: "json", jsonBody: '{"a":1}' },
      },
      { workspaceId: "workspace-1" },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Headers).get("Content-Type")).toBe(
      "application/json",
    )
  })

  test("POST with formEncoded body URL-encodes fields", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await externalRequestService.execute(
      {
        method: "POST",
        url: "https://api.example.com/data",
        headers: [],
        body: {
          bodyType: "formEncoded",
          formFields: [{ key: "name", value: "Ada Lovelace" }],
        },
      },
      { workspaceId: "workspace-1" },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(init.body).toBe("name=Ada+Lovelace")
    expect((init.headers as Headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    )
  })

  test("allContactData body requires a contactId", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      externalRequestService.execute(
        {
          method: "POST",
          url: "https://api.example.com/data",
          headers: [],
          body: { bodyType: "allContactData" },
        },
        { workspaceId: "workspace-1" },
      ),
    ).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test("allContactData body includes contact and custom fields when a contactId is present", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await externalRequestService.execute(
      {
        method: "POST",
        url: "https://api.example.com/data",
        headers: [],
        body: { bodyType: "allContactData" },
      },
      { workspaceId: "workspace-1", contactId: "contact-1" },
    )

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      contact: { id: "contact-1", firstName: "Ada" },
      customFields: [{ customFieldId: "field-1", value: "x" }],
    })
  })
})

describe("externalRequestService.executeAndMap", () => {
  test("returns without writing fields on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    )

    const result = await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input: {
        method: "GET",
        url: "https://api.example.com/data",
        headers: [],
      },
      mapping: [{ jsonPath: "id", outputFieldId: "field-1" }],
    })

    expect(result.statusCode).toBe(500)
    expect(mocks.setValues).not.toHaveBeenCalled()
  })

  test("maps JSON response fields and writes them via contactCustomFieldService", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ user: { id: "abc-123" } }), {
            status: 200,
          }),
      ),
    )

    await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input: {
        method: "GET",
        url: "https://api.example.com/data",
        headers: [],
      },
      mapping: [{ jsonPath: "user.id", outputFieldId: "field-1" }],
    })

    expect(mocks.setValues).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      fields: [{ customFieldId: "field-1", value: "abc-123" }],
      skipInvalidOptions: true,
    })
  })

  test("returns the raw result untouched when the response is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200 })),
    )

    const result = await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input: {
        method: "GET",
        url: "https://api.example.com/data",
        headers: [],
      },
      mapping: [{ jsonPath: "id", outputFieldId: "field-1" }],
    })

    expect(result.responseBody).toBe("not json")
    expect(mocks.setValues).not.toHaveBeenCalled()
  })

  const refusal = () =>
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ status: "refused", code: "bad-args", n: 3 }),
            { status: 400 },
          ),
      ),
    )
  const input = {
    method: "POST" as const,
    url: "https://api.example.com/actions/order.invoice",
    headers: [],
  }

  test("a >= 400 JSON body writes errorMapping (the refusal code), never mapping", async () => {
    refusal()
    const result = await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input,
      mapping: [{ jsonPath: "status", outputFieldId: "field-ok" }],
      errorMapping: [
        { jsonPath: "code", outputFieldId: "field-err" },
        { jsonPath: "n", outputFieldId: "field-n" },
        { jsonPath: "missing.path", outputFieldId: "field-x" },
      ],
    })
    expect(result.statusCode).toBe(400)
    expect(mocks.setValues).toHaveBeenCalledTimes(1)
    expect(mocks.setValues).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      fields: [
        { customFieldId: "field-err", value: "bad-args" },
        { customFieldId: "field-n", value: "3" },
      ],
      skipInvalidOptions: true,
    })
  })

  test("a >= 400 without errorMapping (legacy steps) or with a non-JSON body writes nothing", async () => {
    refusal()
    await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input,
      mapping: [{ jsonPath: "code", outputFieldId: "field-ok" }],
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502</html>", { status: 502 })),
    )
    await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input,
      mapping: [],
      errorMapping: [{ jsonPath: "code", outputFieldId: "field-err" }],
    })
    expect(mocks.setValues).not.toHaveBeenCalled()
  })

  test("a 2xx ignores errorMapping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok", code: "done" }), {
            status: 200,
          }),
      ),
    )
    await externalRequestService.executeAndMap({
      workspaceId: "workspace-1",
      contactId: "contact-1",
      input,
      mapping: [{ jsonPath: "status", outputFieldId: "field-ok" }],
      errorMapping: [{ jsonPath: "code", outputFieldId: "field-err" }],
    })
    expect(mocks.setValues).toHaveBeenCalledWith(
      expect.objectContaining({
        fields: [{ customFieldId: "field-ok", value: "ok" }],
      }),
    )
  })
})
