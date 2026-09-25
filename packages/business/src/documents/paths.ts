/**
 * Object-key layout for contact documents. Kept import-free so the contact
 * and workspace delete paths can purge by prefix without pulling in the
 * documents service (which itself depends on contacts).
 */

/** Every document of every contact in a workspace. */
export const workspaceDocumentsPrefix = (workspaceId: string): string =>
  `workspaces/${workspaceId}/documents/`

/** Every document (rendered and signed PDF) of one contact. */
export const contactDocumentsPrefix = (
  workspaceId: string,
  contactId: string,
): string => `${workspaceDocumentsPrefix(workspaceId)}${contactId}/`

/** Private object key: never under `public/` (anonymous-read prefix). */
export const contactDocumentPath = (
  workspaceId: string,
  contactId: string,
  documentId: string,
): string =>
  `${contactDocumentsPrefix(workspaceId, contactId)}${documentId}.pdf`
