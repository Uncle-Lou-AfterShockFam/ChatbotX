import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

/**
 * Gotenberg (HTML -> PDF) is a trusted internal service beside the hub (on
 * netcup http://gotenberg:3000, never published), called directly like the
 * javascript executor, NOT through the user-facing callApi SSRF guard.
 * Optional: without it, generating a document fails with a clear error.
 */
export const documentsEnv = () =>
  createEnv({
    server: {
      GOTENBERG_URL: z.url().optional(),
    },
    runtimeEnv: process.env,
    skipValidation: process.env.SKIP_ENV_CHECK === "true",
  })
