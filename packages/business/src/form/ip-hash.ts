import { createHash } from "node:crypto"

/**
 * One hash per (workspace, ip): the row never stores the address itself, and
 * the server secret keeps a row reader from brute-forcing IPv4 (2^32 hashes
 * without it; probe, s200). Its own module (s225a) so the submit and the
 * upload service share it without importing each other.
 */
export const hashClientIp = (workspaceId: string, clientIp: string): string =>
  createHash("sha256")
    .update(
      `${process.env.BETTER_AUTH_SECRET ?? ""}|${workspaceId.length}:${workspaceId}|${clientIp}`,
    )
    .digest("hex")
