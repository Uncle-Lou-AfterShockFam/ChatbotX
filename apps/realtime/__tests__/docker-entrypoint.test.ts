import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const ENTRYPOINT = readFileSync(
  join(
    import.meta.dirname,
    "../docker/rootfs/usr/local/bin/docker-entrypoint.sh",
  ),
  "utf8",
)
const DLX_RE = /\bpnpm\s+dlx\b|\bnpx\b/
const EXEC_RE = /\bpnpm exec partykit dev\b/

describe("realtime docker entrypoint (s214)", () => {
  test("runs the lockfile-pinned partykit, never a download at boot", () => {
    // `pnpm dlx` fetched an unpinned partykit from the registry on every
    // container start (supply chain + a network dependency at boot).
    expect(ENTRYPOINT).not.toMatch(DLX_RE)
    expect(ENTRYPOINT).toMatch(EXEC_RE)
  })
})
