export * from "./base62-token"
export * from "./cache-keys"
export * from "./concurrency"
export * from "./datetime"
export * from "./deal-position"
export * from "./encode"
export * from "./env"
export * from "./graph-pagination"
export * from "./id"
export * from "./request"
export * from "./storage"
export * from "./variables"
export * from "./zod"

/** A JSON object (not null, not an array), the shape every jsonb record read expects. */
export const isPlainRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
