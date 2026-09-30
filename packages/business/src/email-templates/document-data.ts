import {
  and,
  type DatabaseClient,
  eq,
  inArray,
} from "@chatbotx.io/database/client"
import { mediaLibraryFileModel } from "@chatbotx.io/database/schema"
import {
  collectRenderInputs,
  DocumentTooLargeError,
  DocumentValidationError,
  type EmailDocument,
  parseDocument,
  type RenderAsset,
} from "@chatbotx.io/email-document"
import { validationException } from "../errors"
import { resolveTenantSettings } from "../platform/settings"
import { getPublicFileUrl } from "../utils"

/**
 * The write + preview helpers shared by everything that stores an
 * EmailDocument v1 (email templates B2, custom pages B4): ONE name rule, ONE
 * validator, ONE media-ownership check.
 */

const MAX_BIGINT = 9_223_372_036_854_775_807n
/** Issues returned to the editor per preview (the first ones are enough). */
const MAX_PREVIEW_ISSUES = 20

/** One schema miss, addressed by its path in the document. */
export type DocumentIssue = { path: string; message: string }

/**
 * A trimmed 1..maxName name and a document that passes `parseDocument`
 * (closed schema, 256 KB cap). A miss is a 422 on the offending field.
 */
export function parseNamedDocument(
  data: { name: unknown; document: unknown },
  maxName: number,
  /** Named in messages: "email document", "page document". */
  noun: string,
): { name: string; document: EmailDocument } {
  if (data === null || typeof data !== "object") {
    throw validationException("name", "A name and a document are required")
  }
  const name = typeof data.name === "string" ? data.name.trim() : ""
  if (name.length === 0 || name.length > maxName) {
    throw validationException(
      "name",
      `The name must be 1-${maxName} characters`,
    )
  }
  try {
    return { name, document: parseDocument(data.document) }
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      throw validationException("document", `The ${noun} is too large`)
    }
    if (error instanceof DocumentValidationError) {
      const first = error.issues[0]
      const path = first?.path.map(String).join(".")
      throw validationException(
        "document",
        `Invalid ${noun}${path ? ` at ${path}` : ""}: ${first?.message ?? "invalid"}`,
      )
    }
    throw error
  }
}

/**
 * A draft for a preview: a schema miss is NOT an error (the editor calls a
 * preview on every change and highlights each issue's path).
 */
export function parsePreviewDocument(
  input: unknown,
  noun: string,
):
  | { ok: true; document: EmailDocument }
  | { ok: false; issues: DocumentIssue[] } {
  let document: EmailDocument
  try {
    document = parseDocument(input)
  } catch (error) {
    if (error instanceof DocumentTooLargeError) {
      return {
        ok: false,
        issues: [{ path: "", message: `The ${noun} is too large` }],
      }
    }
    if (error instanceof DocumentValidationError) {
      return {
        ok: false,
        issues: error.issues.slice(0, MAX_PREVIEW_ISSUES).map((issue) => ({
          path: issue.path.map(String).join("."),
          message: issue.message,
        })),
      }
    }
    throw error
  }
  // s227b: a Liquid template that cannot render is an editor issue (a send
  // of the same document fails closed as content).
  const { invalid } = collectRenderInputs(document)
  if (invalid) {
    return {
      ok: false,
      issues: [{ path: "", message: `Merge template: ${invalid}` }],
    }
  }
  return { ok: true, document }
}

/** The workspace's media rows among `ids` (a foreign id matches nothing). */
async function ownedFiles(
  workspaceId: string,
  ids: string[],
  tx: DatabaseClient,
) {
  // The schema allows 20 digits; a bigint column holds 19. An id past it
  // matches no row, and must not reach Postgres as an out-of-range 500.
  const queryable = ids.filter((id) => BigInt(id) <= MAX_BIGINT)
  if (queryable.length === 0) {
    return []
  }
  return await tx
    .select({
      id: mediaLibraryFileModel.id,
      name: mediaLibraryFileModel.name,
      path: mediaLibraryFileModel.path,
      size: mediaLibraryFileModel.size,
      mimeType: mediaLibraryFileModel.mimeType,
    })
    .from(mediaLibraryFileModel)
    .where(
      and(
        eq(mediaLibraryFileModel.workspaceId, workspaceId),
        inArray(mediaLibraryFileModel.id, queryable),
      ),
    )
}

/**
 * Every media file a document references must be a MediaLibraryFile of THIS
 * workspace: a foreign or deleted id is a 422 at save, never a render that
 * later shows someone else's file.
 */
export async function assertAssetsOwned(
  workspaceId: string,
  document: EmailDocument,
  tx: DatabaseClient,
): Promise<void> {
  const { assetIds } = collectRenderInputs(document)
  const found = new Set(
    (await ownedFiles(workspaceId, assetIds, tx)).map((row) => row.id),
  )
  const missing = assetIds.find((id) => !found.has(id))
  if (missing !== undefined) {
    throw validationException(
      "document",
      `Media file ${missing} is not in this workspace's media library`,
    )
  }
}

/**
 * Public URLs for the document's media, resolved ONLY from this workspace's
 * library; any other id is absent (the renderer reports it in `missing`).
 */
export async function resolveOwnedAssets(
  workspaceId: string,
  document: EmailDocument,
  tx: DatabaseClient,
): Promise<Record<string, RenderAsset>> {
  const { assetIds } = collectRenderInputs(document)
  const rows = await ownedFiles(workspaceId, assetIds, tx)
  const assets: Record<string, RenderAsset> = {}
  if (rows.length > 0) {
    const { storageUrl } = await resolveTenantSettings({ workspaceId })
    for (const row of rows) {
      assets[row.id] = {
        url: getPublicFileUrl(row.path, storageUrl),
        name: row.name,
        size: row.size,
        mimeType: row.mimeType,
      }
    }
  }
  return assets
}
