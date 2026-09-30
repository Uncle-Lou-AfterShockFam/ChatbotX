/**
 * Credential columns an integration row can carry. `userInfo`
 * (Messenger/Instagram) holds the connecting user's Facebook
 * `userAccessToken` next to their name and avatar.
 */
type CredentialColumn = "auth" | "capiAccessToken" | "userInfo"

export type WithoutCredentials<T> = Omit<T, CredentialColumn>

/**
 * An integration row as a client component may receive it (s231a). A prop
 * crossing into `"use client"` is serialized into the RSC payload the browser
 * gets, and `auth` holds bot tokens, page tokens and app client secrets in
 * plaintext (`capiAccessToken` is ciphertext, still never the client's).
 * Server code that needs them reads the row itself.
 */
export const withoutCredentials = <T extends object>(
  row: T,
): WithoutCredentials<T> => {
  const {
    auth: _auth,
    capiAccessToken: _capiAccessToken,
    userInfo: _userInfo,
    ...rest
  } = row as T & {
    auth?: unknown
    capiAccessToken?: unknown
    userInfo?: unknown
  }
  return rest as WithoutCredentials<T>
}
