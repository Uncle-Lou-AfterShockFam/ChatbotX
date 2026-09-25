import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

const DOMAIN_REGEX = /^[a-z0-9.-]+\.[a-z]{2,}$/

/**
 * Gotenberg (HTML -> PDF) is a trusted internal service beside the hub (on
 * netcup http://gotenberg:3000, never published), called directly like the
 * javascript executor, NOT through the user-facing callApi SSRF guard.
 * Optional: without it, generating a document fails with a clear error.
 *
 * Documenso (signing) is operator config the same way: the base URL is never
 * caller input. `DOCUMENSO_WEBHOOK_SECRET` is the secret Documenso echoes in
 * `X-Documenso-Secret`; `DOCUMENSO_SIGNER_DOMAIN` builds the signer address
 * `sig+<contact>@<domain>` (distribution NONE: Documenso mails nobody). All
 * four optional: without them the signing step fails with "not-configured".
 */
export const documentsEnv = () =>
  createEnv({
    server: {
      GOTENBERG_URL: z.url().optional(),
      DOCUMENSO_URL: z.url().optional(),
      DOCUMENSO_API_TOKEN: z.string().min(8).optional(),
      DOCUMENSO_WEBHOOK_SECRET: z.string().min(16).optional(),
      DOCUMENSO_SIGNER_DOMAIN: z.string().regex(DOMAIN_REGEX).optional(),
    },
    runtimeEnv: process.env,
    // The hub override passes `${DOCUMENSO_API_TOKEN:-}`: unset = "", which
    // must read as not configured, not as an invalid token.
    emptyStringAsUndefined: true,
    skipValidation: process.env.SKIP_ENV_CHECK === "true",
  })
