/**
 * Object-key layout for per-contact PUBLIC files (anonymous-read prefix).
 * Import-free, like `documents/paths`, so the contact and workspace delete
 * paths can purge by prefix without a dependency cycle.
 *
 * Only the `contacts/` and `avatars/` subtrees are ever purged: other
 * `public/space/<ws>/` objects (flow media, logos) can be referenced by
 * templates installed into other workspaces, so a workspace delete must not
 * remove them.
 */

/** Every public file of every contact in a workspace. */
export const workspaceContactFilesPrefix = (workspaceId: string): string =>
  `public/space/${workspaceId}/contacts/`

/** Every uploaded avatar of one contact. */
export const contactAvatarPrefix = (
  workspaceId: string,
  contactId: string,
): string => `${workspaceContactFilesPrefix(workspaceId)}${contactId}/avatar/`

/**
 * Channel profile pictures (inbound message / profile refresh / Messenger
 * user info) and integration avatars: one flat object per upload, not a
 * per-contact prefix, so a contact delete removes its own key exactly.
 */
export const workspaceAvatarsPrefix = (workspaceId: string): string =>
  `public/space/${workspaceId}/avatars/`

const CONTACT_AVATAR_KEY =
  /^public\/space\/[^/]+\/contacts\/[^/]+\/avatar\/[^/]+$/

/** True for a key under `contactAvatarPrefix` of ANY contact (any workspace). */
export const isContactAvatarKey = (key: string): boolean =>
  CONTACT_AVATAR_KEY.test(key)
