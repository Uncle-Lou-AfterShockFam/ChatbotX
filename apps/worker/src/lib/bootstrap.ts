import { assertLicenseAtStartup } from "@chatbotx.io/business/license-startup"
import { installPinnedOutboundFetch } from "@chatbotx.io/business/net-node"

// Every worker entry imports this module, so the SSRF-pinned fetch is
// installed at load, before any job can reach a user-supplied URL (s216).
// Without it `outboundFetch` fails closed.
installPinnedOutboundFetch()

async function bootstrapApp(): Promise<void> {
  await assertLicenseAtStartup()
}

let bootstrapPromise: Promise<void> | null = null

export async function ensureBootstrapped(): Promise<void> {
  if (!bootstrapPromise) {
    bootstrapPromise = Promise.resolve().then(() => bootstrapApp())
  }

  await bootstrapPromise
}
