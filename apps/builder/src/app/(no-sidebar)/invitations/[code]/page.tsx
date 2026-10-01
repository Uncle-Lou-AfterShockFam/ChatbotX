import { InvitationCard } from "@/features/invitations/invitatation-card"
import { findInvitation } from "@/features/invitations/queries"

type InvitationsPageProps = {
  params: Promise<{ code: string }>
}

export default async function InvitationsPage(props: InvitationsPageProps) {
  const params = await props.params
  // null (unknown / expired code, deleted inviter) renders the card's
  // invalid-invitation state, never a 500 (s233a).
  const invitation = await findInvitation({ code: params.code })

  return (
    <div className="flex h-screen w-screen items-center justify-center">
      <InvitationCard invitation={invitation} />
    </div>
  )
}
