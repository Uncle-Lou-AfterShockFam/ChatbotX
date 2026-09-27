import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

export const keys = () =>
  createEnv({
    server: {
      NEXT_PUBLIC_EDITION: z
        .enum(["community", "enterprise", "cloud"])
        .default("community"),
      NEXT_PUBLIC_BUILDER_URL: z.url().default("http://localhost:3123"),
      // The OAuth broker host, when it is not the builder. Dynamic Image
      // trigger URLs are built on it (`getBrokerOrigin`).
      NEXT_PUBLIC_BROKER_URL: z.url().optional(),
      PLATFORM_ADMIN_EMAIL: z.email().optional(),
      LICENSE_KEY: z.string().optional(),
    },
    runtimeEnv: process.env,
  })

export const env = keys()

export const isCommunity = () => keys().NEXT_PUBLIC_EDITION === "community"
export const isEnterprise = () => keys().NEXT_PUBLIC_EDITION === "enterprise"
export const isCloud = () => keys().NEXT_PUBLIC_EDITION === "cloud"
