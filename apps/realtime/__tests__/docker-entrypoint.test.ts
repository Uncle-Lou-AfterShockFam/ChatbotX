import { spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

const SCRIPT = join(
  import.meta.dirname,
  "../docker/rootfs/usr/local/bin/docker-entrypoint.sh",
)
const DLX_RE = /\bpnpm\s+dlx\b|\bnpx\b/

let dir: string

// A fake `pnpm` that records its argv and the env it was started with.
const FAKE_PNPM = `#!/bin/bash
printf '%s\\n' "$*" > "$REALTIME_APP_DIR/argv"
printf '%s\\n' "$NODE_OPTIONS" > "$REALTIME_APP_DIR/node_options"
printf '%s\\n' "$PORT" > "$REALTIME_APP_DIR/port"
`

function run(env: Record<string, string | undefined>) {
  return spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${dir}/bin:/usr/bin:/bin`,
      REALTIME_APP_DIR: dir,
      ...env,
    } as NodeJS.ProcessEnv,
    encoding: "utf8",
  })
}

describe("realtime docker entrypoint (s214)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rt-entry-"))
    const bin = join(dir, "bin")
    spawnSync("mkdir", ["-p", bin])
    writeFileSync(join(bin, "pnpm"), FAKE_PNPM)
    chmodSync(join(bin, "pnpm"), 0o755)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("never downloads partykit at boot", () => {
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(DLX_RE)
  })

  test("writes the secret to a private .env, then runs the pinned partykit", () => {
    const result = run({
      REALTIME_BROADCAST_SECRET: "s3cret=with=equals",
      NODE_OPTIONS: "--max_old_space_size=512",
    })
    expect(result.status).toBe(0)
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "REALTIME_BROADCAST_SECRET=s3cret=with=equals\n",
    )
    expect(statSync(join(dir, ".env")).mode.toString(8).slice(-3)).toBe("600")
    expect(readFileSync(join(dir, "argv"), "utf8").trim()).toBe(
      "exec partykit dev",
    )
    // The memory cap from the environment survives.
    const nodeOptions = readFileSync(join(dir, "node_options"), "utf8")
    expect(nodeOptions).toContain("--no-node-snapshot")
    expect(nodeOptions).toContain("--max_old_space_size=512")
    expect(readFileSync(join(dir, "port"), "utf8").trim()).toBe("1999")
  })

  test.each([
    ["missing", undefined],
    ["empty", ""],
  ])("refuses to start with a %s secret, and never runs partykit", (_label, secret) => {
    const result = run({ REALTIME_BROADCAST_SECRET: secret })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("REALTIME_BROADCAST_SECRET is required")
    expect(() => readFileSync(join(dir, "argv"))).toThrow()
  })
})
