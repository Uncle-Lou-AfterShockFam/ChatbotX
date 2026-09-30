/** Credential columns an integration row can carry. */
type CredentialColumn = "auth" | "capiAccessToken"

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
    ...rest
  } = row as T & { auth?: unknown; capiAccessToken?: unknown }
  return rest as WithoutCredentials<T>
}
