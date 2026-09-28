/**
 * Object-key layout for per-contact PUBLIC files (anonymous-read prefix).
 * Import-free, like `documents/paths`, so the contact and workspace delete
 * paths can purge by prefix without a dependency cycle.
 *
 * Only the `contacts/` subtree is ever purged: other `public/space/<ws>/`
 * objects (flow media, logos) can be referenced by templates installed into
 * other workspaces, so a workspace delete must not remove them.
 */

/** Every public file of every contact in a workspace. */
export const workspaceContactFilesPrefix = (workspaceId: string): string =>
  `public/space/${workspaceId}/contacts/`

/** Every uploaded avatar of one contact. */
export const contactAvatarPrefix = (
  workspaceId: string,
  contactId: string,
): string => `${workspaceContactFilesPrefix(workspaceId)}${contactId}/avatar/`
