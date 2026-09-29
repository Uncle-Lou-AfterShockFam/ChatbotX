import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

export const keys = () =>
  createEnv({
    server: {
      S3_ENDPOINT: z.url().optional(),
      S3_ACCESS_KEY_ID: z.string().min(1).optional(),
      S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
      S3_REGION: z.string().min(1),
      S3_BUCKET: z.string().min(1),
      // Self-host behind a proxy: the base the BROWSER puts signed uploads to
      // (e.g. https://hub.example/storage), which the proxy maps to
      // ${S3_ENDPOINT}/${S3_BUCKET} keeping the endpoint's Host header (the
      // signature covers it). Unset = the endpoint itself is browser-reachable.
      S3_PUBLIC_UPLOAD_URL: z.url().optional(),
    },
    runtimeEnv: process.env,
    skipValidation: process.env.SKIP_ENV_CHECK === "true",
  })

export const filesystemEnv = keys()
