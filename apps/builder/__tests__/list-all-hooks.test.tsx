// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { listRows, pagedServer } from "@/lib/query/__tests__/paged-server"

// s205: every "load all" hook used one `perPage: maxPerPage` call that the
// server caps at 50 rows. Each hook must page to the end, and the invalidate
// helpers must still reach the paged query's key.

const mocks = vi.hoisted(() => ({
  tags: vi.fn(),
  companies: vi.fn(),
  agents: vi.fn(),
  members: vi.fn(),
  deals: vi.fn(),
}))

vi.mock("@/lib/orpc/orpc", () => ({
  client: {
    tagsAPI: { privateListWorkspaceTagsAPI: mocks.tags },
    companiesAPI: { privateListWorkspaceCompaniesAPI: mocks.companies },
    aiAgentsAPI: { listAIAgentsAPI: mocks.agents },
    workspaceMembersAPI: {
      listWorkspaceMembersAuthenticatedAPI: mocks.members,
    },
    dealsAPI: { privateListWorkspaceDealsAPI: mocks.deals },
  },
}))

const { useTags, useInvalidateTags } = await import(
  "../src/features/tags/provider/tag-hook"
)
const { useCompanies, useInvalidateCompanies } = await import(
  "../src/features/companies/provider/company-hook"
)
const { useAIAgents } = await import(
  "../src/features/ai-agents/hooks/use-ai-agents"
)
const { useOwnerOptions } = await import(
  "../src/features/deals/provider/deal-hook"
)
const { useContactDeals } = await import(
  "../src/features/crm/provider/crm-hooks"
)

let container: HTMLDivElement
let root: Root
let queryClient: QueryClient

beforeEach(() => {
  for (const m of Object.values(mocks)) {
    m.mockReset()
  }
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderHook = <T,>(useHook: () => T) => {
  const latest: { value: T | undefined } = { value: undefined }
  function Probe() {
    latest.value = useHook()
    return null
  }
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    )
  })
  return latest
}

const members = listRows(1, 121).map((r) => ({
  ...r,
  userId: `u${r.id}`,
  user: { name: r.name },
}))

describe.each([
  ["useTags", mocks.tags, () => useTags("ws1").data],
  ["useCompanies", mocks.companies, () => useCompanies("ws1").data],
  ["useAIAgents", mocks.agents, () => useAIAgents("ws1").data],
])("%s", (_, mock, useData) => {
  test("all 120 rows land in 3 calls, not the first 50", async () => {
    mock.mockImplementation(pagedServer(listRows(1, 121)))

    const result = renderHook(useData)

    await vi.waitFor(() => expect(result.value).toHaveLength(120))
    expect(mock).toHaveBeenCalledTimes(3)
    expect(mock).toHaveBeenNthCalledWith(3, {
      workspaceId: "ws1",
      page: 3,
      perPage: 50,
      sort: [{ id: "id", desc: false }],
    })
  })
})

test("useOwnerOptions: all 120 members become options", async () => {
  mocks.members.mockImplementation(pagedServer(members))

  const result = renderHook(() => useOwnerOptions("ws1"))

  await vi.waitFor(() => expect(result.value).toHaveLength(120))
  expect(result.value?.at(-1)).toEqual({ label: "row 120", value: "u120" })
})

test("useContactDeals: every deal, newest first", async () => {
  mocks.deals.mockImplementation(pagedServer(listRows(1, 76)))

  const result = renderHook(() => useContactDeals("ws1", "c1").data)

  await vi.waitFor(() => expect(result.value).toHaveLength(75))
  expect(result.value?.[0]?.id).toBe("75")
  expect(mocks.deals.mock.calls[0][0]).toMatchObject({
    workspaceId: "ws1",
    contactId: "c1",
    sort: [{ id: "id", desc: true }],
  })
})

test.each([
  ["tags", mocks.tags, useTags, useInvalidateTags],
  ["companies", mocks.companies, useCompanies, useInvalidateCompanies],
])("invalidating %s refetches the paged query", async (_, mock, useList, useInvalidate) => {
  mock.mockImplementation(pagedServer(listRows(1, 3)))
  const result = renderHook(() => ({
    data: useList("ws1").data,
    invalidate: useInvalidate(),
  }))
  await vi.waitFor(() => expect(result.value?.data).toHaveLength(2))

  mock.mockImplementation(pagedServer(listRows(1, 4)))
  await act(async () => {
    await result.value?.invalidate()
  })

  await vi.waitFor(() => expect(result.value?.data).toHaveLength(3))
})

test("a malformed page surfaces as a query error, not a hang", async () => {
  mocks.tags.mockResolvedValue({ data: null })

  const result = renderHook(() => useTags("ws1"))

  await vi.waitFor(() => expect(result.value?.isError).toBe(true))
  expect(mocks.tags).toHaveBeenCalledTimes(1)
})
