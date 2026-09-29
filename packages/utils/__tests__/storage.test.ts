import { describe, expect, test } from "vitest"
import { getPublicFileUrl, isWorkspaceStorageKey } from "../src/storage"

// The base of interest carries a bucket path segment (e.g. RustFS/S3 proxy),
// which is exactly the shape `new URL` silently drops when misused.
const BUCKET_BASE = "https://filesystem.example.com/chatbotx/"

describe("getPublicFileUrl", () => {
  test("joins a bare object key under the bucket base", () => {
    expect(getPublicFileUrl("public/space/1/avatar/abc", BUCKET_BASE)).toBe(
      "https://filesystem.example.com/chatbotx/public/space/1/avatar/abc",
    )
  })

  test("keeps the bucket even when the key has a leading slash", () => {
    // Naive `new URL("/public/...", base)` would drop "/chatbotx".
    expect(getPublicFileUrl("/public/space/1/avatar/abc", BUCKET_BASE)).toBe(
      "https://filesystem.example.com/chatbotx/public/space/1/avatar/abc",
    )
  })

  test("keeps the bucket even when the base has no trailing slash", () => {
    expect(
      getPublicFileUrl(
        "public/space/1/avatar/abc",
        "https://filesystem.example.com/chatbotx",
      ),
    ).toBe("https://filesystem.example.com/chatbotx/public/space/1/avatar/abc")
  })

  test("works with a bucket-less CDN base", () => {
    expect(getPublicFileUrl("public/x.png", "https://cdn.example.com/")).toBe(
      "https://cdn.example.com/public/x.png",
    )
  })

  test("returns an already-absolute http(s) path unchanged", () => {
    const absolute = "https://scontent.fbcdn.net/v/t1/avatar.jpg"
    expect(getPublicFileUrl(absolute, BUCKET_BASE)).toBe(absolute)
  })
})

describe("isWorkspaceStorageKey (s221b: traversal closes the cross-tenant key)", () => {
  test("a plain key under the workspace's own prefixes passes", () => {
    expect(isWorkspaceStorageKey("workspaces/7/media/a.pdf", "7")).toBe(true)
    expect(isWorkspaceStorageKey("public/space/7/media/a b%20c.png", "7")).toBe(
      true,
    )
  })

  test("another workspace, a prefix look-alike or no prefix fails", () => {
    for (const path of [
      "workspaces/8/media/a.pdf",
      "workspaces/77/media/a.pdf",
      "public/space/70/x",
      "media/a.pdf",
      "workspaces/7",
      "",
    ]) {
      expect(isWorkspaceStorageKey(path, "7")).toBe(false)
    }
  })

  test("dot segments, empty segments, backslashes, encoded dots/separators and control chars fail", () => {
    for (const path of [
      "workspaces/7/../8/documents/x.pdf",
      "workspaces/7/media/../../8/x",
      "workspaces/7/./media/x",
      "workspaces/7//media/x",
      "workspaces/7/media/",
      "workspaces/7/media\\..\\x",
      "workspaces/7/%2e%2e/8/x",
      "workspaces/7/%2E%2E/8/x",
      "workspaces/7/..%2f8/x",
      "workspaces/7/..%5C8/x",
      "workspaces/7/media/x\u0000.pdf",
      "workspaces/7/media/x\n.pdf",
    ]) {
      expect(isWorkspaceStorageKey(path, "7")).toBe(false)
    }
  })

  test("wrong types and an empty workspace fail closed", () => {
    expect(isWorkspaceStorageKey(null as never, "7")).toBe(false)
    expect(isWorkspaceStorageKey(42 as never, "7")).toBe(false)
    expect(isWorkspaceStorageKey("workspaces//x", "")).toBe(false)
  })

  test("property: no key that passes can resolve (POSIX-normalized) outside the prefix", () => {
    const parts = ["a", "..", ".", "", "7", "8", "%2e", "b.pdf", "workspaces"]
    let seed = 11
    const pick = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return parts[seed % parts.length] as string
    }
    for (let i = 0; i < 2000; i++) {
      const tail = Array.from({ length: 1 + (i % 5) }, pick).join("/")
      const path = `workspaces/7/${tail}`
      if (!isWorkspaceStorageKey(path, "7")) {
        continue
      }
      const normalized = new URL(path, "https://s3.test/bucket/").pathname
      expect(normalized.startsWith("/bucket/workspaces/7/")).toBe(true)
    }
  })
})
