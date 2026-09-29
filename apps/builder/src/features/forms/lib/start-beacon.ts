/**
 * The web abandon beacon (s224a A2-4): the first interaction with a page a
 * PERSONAL link opened tells the hub the contact started the form. Fires at
 * most once per page load; without a link token it never fires (an
 * anonymous visitor has no visit). Best effort: a failed beacon only means
 * no abandon event, never a broken form.
 */
export function createFormStartBeacon(props: {
  workspaceId: string
  slug: string
  formLinkToken: string | undefined
  send?: (url: string, init: RequestInit) => Promise<unknown>
}): () => void {
  let sent = false
  const send = props.send ?? ((url, init) => fetch(url, init))
  return () => {
    if (sent || !props.formLinkToken) {
      return
    }
    sent = true
    send(`/api/forms/${props.workspaceId}/${props.slug}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ k: props.formLinkToken }),
      keepalive: true,
    }).catch(() => undefined)
  }
}
