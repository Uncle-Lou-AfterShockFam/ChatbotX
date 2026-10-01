// @vitest-environment node
import { readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { collectSourceFiles } from "./source-files.test-utils"

/**
 * s233a: the Workspace row carries the deprecated plaintext `token`. A client
 * component never receives the raw row: it gets a projection (a `Pick`, or
 * `toWorkspaceResource`). Three pages sent it before this gate (ai-agents,
 * invitations, settings/general).
 */
const SRC_ROOT = join(import.meta.dirname, "..", "src")
const LEADING_COMMENTS = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/
const USE_CLIENT = /^["']use client["']/
/** `WorkspaceModel` anywhere except as the first argument of a `Pick<>`. */
const RAW_WORKSPACE_MODEL = /(?<!Pick<\s*)\bWorkspaceModel\b(?!\s*,\s*["'])/
const IMPORT_LINE = /^import[^\n]*$/gm
/** A JSX prop handed a raw `...targetWorkspace` (getCurrentUserAndTargetWorkspace). */
const RAW_TARGET_WORKSPACE_PROP = /=\{[\w.?]*targetWorkspace\}/

const isClientFile = (source: string) =>
  USE_CLIENT.test(source.replace(LEADING_COMMENTS, ""))

const files = collectSourceFiles(SRC_ROOT).map((path) => ({
  path: relative(SRC_ROOT, path),
  source: readFileSync(path, "utf8"),
}))

describe("no raw Workspace row reaches a client component", () => {
  test("scanner self-check", () => {
    const flagged = (s: string) =>
      RAW_WORKSPACE_MODEL.test(s.replace(IMPORT_LINE, ""))
    expect(flagged("type P = { workspace: WorkspaceModel }")).toBe(true)
    expect(flagged("type P = WorkspaceModel | null")).toBe(true)
    expect(flagged('type P = Pick<WorkspaceModel, "name">')).toBe(false)
    expect(flagged('import type { WorkspaceModel } from "x"')).toBe(false)
    expect(
      RAW_TARGET_WORKSPACE_PROP.test("workspace={u.targetWorkspace}"),
    ).toBe(true)
    expect(
      RAW_TARGET_WORKSPACE_PROP.test(
        "workspace={toWorkspaceResource(u.targetWorkspace)}",
      ),
    ).toBe(false)
    expect(isClientFile('// c\n"use client"\nexport {}')).toBe(true)
    expect(isClientFile('"use server"')).toBe(false)
  })

  test("sanity floor: the walk sees the builder", () => {
    expect(files.length).toBeGreaterThan(2000)
    expect(files.filter((f) => isClientFile(f.source)).length).toBeGreaterThan(
      500,
    )
  })

  test("no 'use client' file types a prop as the raw WorkspaceModel", () => {
    const offenders = files
      .filter((f) => isClientFile(f.source))
      .filter((f) =>
        RAW_WORKSPACE_MODEL.test(f.source.replace(IMPORT_LINE, "")),
      )
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })

  test("no page passes getCurrentUserAndTargetWorkspace's row raw as a JSX prop", () => {
    const offenders = files
      .filter((f) => f.path.endsWith(".tsx"))
      .filter((f) => RAW_TARGET_WORKSPACE_PROP.test(f.source))
      .map((f) => f.path)
    expect(offenders).toEqual([])
  })
})

describe("toWorkspaceResource", () => {
  test("drops token, keeps everything else, leaves the input alone", async () => {
    const { toWorkspaceResource } = await import(
      "@/features/workspaces/schema/resource"
    )
    const row = { id: "1", name: "Acme", token: "SECRET", logo: null }
    expect(toWorkspaceResource(row)).toEqual({
      id: "1",
      name: "Acme",
      logo: null,
    })
    expect(row.token).toBe("SECRET")
  })
})

const mocks = vi.hoisted(() => ({ findById: vi.fn() }))
vi.mock("@chatbotx.io/business", () => ({
  workspaceService: { findById: mocks.findById },
}))
vi.mock("@/features/ai-agents/queries", () => ({
  listAIAgents: vi.fn().mockResolvedValue({ data: [], pageCount: 0 }),
}))
vi.mock("@/features/integration-openai-compatible/queries", () => ({
  listIntegrationOpenaiCompatible: vi.fn().mockResolvedValue([]),
}))
vi.mock("@/features/ai-agents/ai-agent-table", () => ({
  AIAgentsTable: () => null,
}))
vi.mock("@/features/ai-hub/ai-hub-breadcrumb", () => ({ AITab: () => null }))

type Node = { props?: { children?: unknown; promises?: unknown } }
const findPromises = (node: unknown): unknown => {
  const n = node as Node
  if (n?.props?.promises) {
    return n.props.promises
  }
  const children = n?.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = child ? findPromises(child) : undefined
    if (found) {
      return found
    }
  }
  return
}

describe("AI agents page", () => {
  beforeEach(() => mocks.findById.mockReset())

  test("the table gets smartResponseDelaySeconds only, never the row", async () => {
    mocks.findById.mockResolvedValue({
      id: "1",
      name: "Acme",
      token: "SECRET",
      smartResponseDelaySeconds: 7,
    })
    const { default: AIAgentsPage } = await import(
      "@/app/space/[workspaceId]/(ai)/ai-agents/page"
    )
    const page = await AIAgentsPage({
      params: Promise.resolve({ workspaceId: "1" }),
      searchParams: Promise.resolve({}),
    })
    const [, , workspace] = (await findPromises(page)) as unknown[]
    expect(workspace).toEqual({ smartResponseDelaySeconds: 7 })
  })
})
