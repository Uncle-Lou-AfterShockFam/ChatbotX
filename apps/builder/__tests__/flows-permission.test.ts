// @vitest-environment node
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { findTemplateStartStep } from "@chatbotx.io/flow-config"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { getFlowNodesOptions } from "@/features/flows/provider/flow-hook"
import { serverActionExports } from "./server-action-exports.test-utils"
import { collectSourceFiles } from "./source-files.test-utils"

/**
 * s234a (owner decision 2026-10-01): the flows pages need the `flows`
 * permission, but every flow action and private route only checked
 * membership, and the flow LIST / versions routes returned full step config
 * to any member. Writes and the per-flow read routes now need `flows`; the
 * list stays membership-only for the pickers on other screens but projects
 * the step config away for a member without `flows`.
 */
const mocks = vi.hoisted(() => {
  type Handler = (args: {
    input: Record<string, unknown>
    context: { member: { permissions: Record<string, unknown> } }
  }) => Promise<unknown>
  const routes = new Map<string, { middleware?: unknown; handler?: Handler }>()
  const route = (config: { method: string; path: string }) => {
    const state: { middleware?: unknown; handler?: Handler } = {}
    routes.set(`${config.method} ${config.path}`, state)
    const procedure = {
      input: () => procedure,
      output: () => procedure,
      use: (middleware: unknown) => {
        state.middleware = middleware
        return procedure
      },
      handler: (handler: Handler) => {
        state.handler = handler
        return { handler }
      },
    }
    return procedure
  }
  return {
    routes,
    authorizedAPI: { route },
    listFlows: vi.fn(),
    subtreeFolderTypes: vi.fn(),
    workspaceAuthorizedMidddleware: Symbol("membership"),
    flowsAuthorizedMiddleware: Symbol("flows"),
  }
})

vi.mock("server-only", () => ({}))
vi.mock("@/orpc", () => ({ authorizedAPI: mocks.authorizedAPI }))
vi.mock("@/middlewares/auth", () => ({
  workspaceAuthorizedMidddleware: mocks.workspaceAuthorizedMidddleware,
  flowsAuthorizedMiddleware: mocks.flowsAuthorizedMiddleware,
}))
vi.mock("@/features/flows/queries", () => ({ listFlows: mocks.listFlows }))
vi.mock("@chatbotx.io/analytics", () => ({
  flowAnalyticsService: {},
  flowNodeStatsResponse: {},
  flowStatsRequest: {},
}))
vi.mock("@chatbotx.io/business", () => ({
  flowVersionService: {},
  folderService: { subtreeFolderTypes: mocks.subtreeFolderTypes },
}))
vi.mock("@chatbotx.io/integration-messenger/messenger-ads", () => ({
  convertStartNodeToMessengerAdsJson: vi.fn(),
}))

const { privateFlowsAPI } = await import("@/features/flows/api/private")
const { assertFolderIdsAccess, assertFolderTypeAccess } = await import(
  "@/features/folders/lib/folder-permission"
)

const SECRET = "s3cret-step-config"

/** One flow with a start node (template step + a message) and a request node. */
const flowRow = () => ({
  id: "10",
  name: "Welcome",
  workspaceId: "1",
  flowVersions: [
    {
      id: "100",
      isLatest: true,
      isDraft: false,
      nodes: [
        {
          id: "n1",
          type: "custom",
          position: { x: 1, y: 2 },
          data: {
            name: "Start",
            isStartNode: true,
            details: {
              steps: [
                {
                  stepType: "sendWaTemplateMessage",
                  template: { id: "tpl-1", body: SECRET },
                  variables: [SECRET],
                },
                { stepType: "sendText", text: SECRET },
              ],
            },
          },
        },
        {
          id: "n2",
          type: "custom",
          data: {
            name: "Call API",
            details: {
              steps: [
                {
                  stepType: "externalRequest",
                  url: `https://api.example.com/?key=${SECRET}`,
                  headers: { Authorization: `Bearer ${SECRET}` },
                },
              ],
            },
          },
        },
      ],
      edges: [{ id: "e1", source: "n1", target: "n2", data: SECRET }],
    },
  ],
})

const listRoute = () => mocks.routes.get("GET /workspaces/{workspaceId}/flows")

const listAs = async (permissions: Record<string, unknown>) =>
  (await listRoute()?.handler?.({
    input: { workspaceId: "1", page: 1, perPage: 10 },
    context: { member: { permissions } },
  })) as { data: ReturnType<typeof flowRow>[]; pageCount: number }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listFlows.mockResolvedValue({ data: [flowRow()], pageCount: 1 })
})

describe("flow list: slim for a member without flows", () => {
  test("the list route stays on membership (the pickers on other screens)", () => {
    expect(listRoute()?.middleware).toBe(mocks.workspaceAuthorizedMidddleware)
  })

  test("no step config, URL, header or edge reaches a member without flows", async () => {
    for (const permissions of [
      {},
      { contacts: true, broadcast: true },
      { flows: "true" },
      { superAdmin: "true" },
    ]) {
      const result = await listAs(permissions)
      expect(JSON.stringify(result)).not.toContain(SECRET)
      const [version] = result.data[0]?.flowVersions ?? []
      expect(version?.edges).toEqual([])
      expect(version?.nodes).toEqual([
        {
          id: "n1",
          type: "custom",
          data: {
            name: "Start",
            isStartNode: true,
            details: {
              steps: [
                {
                  stepType: "sendWaTemplateMessage",
                  template: { id: "tpl-1" },
                },
              ],
            },
          },
        },
        { id: "n2", type: "custom", data: { name: "Call API" } },
      ])
      expect(result.pageCount).toBe(1)
    }
  })

  test("the pickers read the same answers from the slim list", async () => {
    const full = flowRow()
    const [slim] = (await listAs({ contacts: true })).data
    expect(getFlowNodesOptions(slim?.flowVersions as never)).toEqual(
      getFlowNodesOptions(full.flowVersions as never),
    )
    expect(
      findTemplateStartStep(
        slim?.flowVersions[0]?.nodes,
        "sendWaTemplateMessage",
      ),
    ).toEqual(
      findTemplateStartStep(
        full.flowVersions[0]?.nodes,
        "sendWaTemplateMessage",
      ),
    )
    expect(
      findTemplateStartStep(
        slim?.flowVersions[0]?.nodes,
        "sendWaTemplateMessage",
      ),
    ).toEqual({ stepType: "sendWaTemplateMessage", templateId: "tpl-1" })
  })

  test("the slim nodes and edges pass the route's real output schema", async () => {
    const { flowVersionResource } = await import(
      "@/features/flow-versions/schema/resource"
    )
    const [version] = (await listAs({})).data[0]?.flowVersions ?? []
    const { nodes, edges } = flowVersionResource.shape
    expect(nodes.safeParse(version?.nodes).success).toBe(true)
    expect(edges.safeParse(version?.edges).success).toBe(true)
  })

  test("flows or superAdmin gets the full rows", async () => {
    for (const permissions of [{ flows: true }, { superAdmin: true }]) {
      expect(await listAs(permissions)).toEqual({
        data: [flowRow()],
        pageCount: 1,
      })
    }
  })

  test("malformed nodes project without throwing", async () => {
    mocks.listFlows.mockResolvedValue({
      data: [
        {
          ...flowRow(),
          flowVersions: [
            {
              id: "1",
              nodes: [
                { id: "a" },
                { id: "b", data: null },
                { id: "c", data: { name: 7, isStartNode: true, details: [] } },
                {
                  id: "d",
                  data: {
                    isStartNode: true,
                    details: { steps: [null, "x", { stepType: "t" }] },
                  },
                },
              ],
              edges: [],
            },
          ],
        },
      ],
      pageCount: 1,
    })
    const [flow] = (await listAs({})).data
    expect(flow?.flowVersions[0]?.nodes).toEqual([
      { id: "a", data: {} },
      { id: "b", data: {} },
      { id: "c", data: { isStartNode: true, details: { steps: [] } } },
      { id: "d", data: { isStartNode: true, details: { steps: [] } } },
    ])
  })
})

describe("per-flow read routes and the stats reset need flows", () => {
  test.each([
    "GET /workspaces/{workspaceId}/flows/{flowId}/versions",
    "GET /workspaces/{workspaceId}/flows/{flowId}/stats",
    "DELETE /workspaces/{workspaceId}/flows/{flowId}/stats",
    "GET /workspaces/{workspaceId}/flows/{flowId}/messenger-ads-json",
  ])("%s", (key) => {
    expect(mocks.routes.get(key)?.middleware).toBe(
      mocks.flowsAuthorizedMiddleware,
    )
  })

  test("every registered flow route is accounted for", () => {
    expect(privateFlowsAPI).toBeDefined()
    expect(mocks.routes.size).toBe(5)
  })
})

describe("flow folders need flows; other folder types stay membership-only", () => {
  test("create / change by type", () => {
    expect(() => assertFolderTypeAccess({}, "flow")).toThrow(
      "Flows access required",
    )
    expect(() => assertFolderTypeAccess({ flows: "true" }, "flow")).toThrow()
    expect(() => assertFolderTypeAccess({ flows: true }, "flow")).not.toThrow()
    expect(() =>
      assertFolderTypeAccess({ superAdmin: true }, "flow"),
    ).not.toThrow()
    expect(() => assertFolderTypeAccess({}, "tag")).not.toThrow()
    expect(() => assertFolderTypeAccess({}, "sequence")).not.toThrow()
  })

  test("edit / delete by id: a flow folder among the ids is refused", async () => {
    mocks.subtreeFolderTypes.mockResolvedValue(["tag", "flow"])
    await expect(
      assertFolderIdsAccess({
        workspaceId: "1",
        permissions: {},
        ids: ["1", "2"],
      }),
    ).rejects.toThrow("Flows access required")
    expect(mocks.subtreeFolderTypes).toHaveBeenCalledWith({
      workspaceId: "1",
      ids: ["1", "2"],
    })
  })

  test("edit / delete by id: non-flow folders, empty ids, or flows pass", async () => {
    mocks.subtreeFolderTypes.mockResolvedValue(["tag"])
    await expect(
      assertFolderIdsAccess({ workspaceId: "1", permissions: {}, ids: ["1"] }),
    ).resolves.toBeUndefined()
    await expect(
      assertFolderIdsAccess({ workspaceId: "1", permissions: {}, ids: [] }),
    ).resolves.toBeUndefined()
    await expect(
      assertFolderIdsAccess({
        workspaceId: "1",
        permissions: { flows: true },
        ids: ["2"],
      }),
    ).resolves.toBeUndefined()
    expect(mocks.subtreeFolderTypes).toHaveBeenCalledTimes(1)
  })
})

describe("every flow action is built on a flows client", () => {
  const FEATURES = join(import.meta.dirname, "..", "src", "features")
  const read = (path: string) => readFileSync(path, "utf8")

  test("the flows feature actions", () => {
    const offenders: string[] = []
    let seen = 0
    for (const path of collectSourceFiles(join(FEATURES, "flows"))) {
      for (const { name, root } of serverActionExports(path, read(path))) {
        seen += 1
        if (!root?.startsWith("flowsActionClient")) {
          offenders.push(`${name}: ${root}`)
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(10)
    expect(offenders).toEqual([])
  })

  test("a flow delete stays open on an expired workspace (invariant #14)", () => {
    const path = join(FEATURES, "flows", "actions", "delete-flow.action.ts")
    expect(serverActionExports(path, read(path))).toEqual([
      { name: "deleteFlowAction", root: "flowsActionClientAllowExpired" },
    ])
  })

  test("each folder action checks the folder type", () => {
    const checks: Record<string, string> = {
      "create-folder.action.ts": "assertFolderTypeAccess(",
      "change-folder.action.ts": "assertFolderTypeAccess(",
      "edit-folder-action.ts": "assertFolderIdsAccess(",
      "delete-folder.action.ts": "assertFolderIdsAccess(",
    }
    for (const [file, call] of Object.entries(checks)) {
      expect(read(join(FEATURES, "folders", "actions", file)), file).toContain(
        call,
      )
    }
  })
})
