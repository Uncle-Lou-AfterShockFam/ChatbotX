import { DocumentTooLargeError, DocumentValidationError } from "./errors"
import {
  type EmailDocument,
  emailDocumentSchema,
  MAX_DOCUMENT_BYTES,
} from "./schema"

/**
 * The only entry point for untrusted input (API bodies, stored jsonb). Size is
 * checked BEFORE the schema walk so an oversized payload costs one
 * `JSON.stringify`, never a full validation.
 */
export function parseDocument(input: unknown): EmailDocument {
  if (input === null || typeof input !== "object") {
    throw new DocumentValidationError([
      { path: [], message: "must be an object" },
    ])
  }
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new DocumentValidationError([
      { path: [], message: "is not JSON-serializable" },
    ])
  }
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError(bytes, MAX_DOCUMENT_BYTES)
  }
  const result = emailDocumentSchema.safeParse(input)
  if (!result.success) {
    throw new DocumentValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message,
      })),
    )
  }
  return result.data
}
