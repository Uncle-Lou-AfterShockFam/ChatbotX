import { randomUUID } from "node:crypto"
import { emailTopicAnalyticsService } from "@chatbotx.io/analytics"
import {
  contactInboxService,
  conversationService,
  emailTopicService,
  flowService,
  messageService,
  verifyEmailFlowToken,
} from "@chatbotx.io/business"
import { pageService } from "@chatbotx.io/business/page"
import { cacheConnections } from "@chatbotx.io/redis"
import { logger } from "@/lib/log"
import { loadServableWorkspace } from "@/lib/workspace/load-servable-workspace"

export type EmailFlowStatus = "valid" | "invalid" | "unavailable" | "started"

/**
 * The once-per-link claim (Codex + lifecycle probe s222b). The ENQUEUE is the
 * idempotency guarantee: its queue job id is derived from the sealed link id,
 * so a retry after a crash or a lost reply is a no-op while the job is
 * retained. The Redis claim only keeps two concurrent clicks from both
 * trying: taken with an owner nonce for a few minutes (a crash frees it),
 * released only by its owner (compare-and-delete), then held as `queued` for
 * the token's life.
 */
const PENDING_TTL_SECONDS = 5 * 60
const QUEUED_TTL_SECONDS = 366 * 24 * 60 * 60
const QUEUED = "queued"
const RELEASE_IF_OWNER =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
const claimKey = (linkId: string) => `email-flow:start:${linkId}`
// The shared cache connection, renamed so the React hook lint rule does not
// read `useExisting` as a hook (it takes no `this`).
const { useExisting: cacheRedis } = cacheConnections

type Checked = {
  status: EmailFlowStatus
  workspaceId?: string
  linkId?: string
  started?: boolean
  start?: () => Promise<void>
}

/**
 * B2 phase 4 (s222b): verifies a newsletter's start-flow button WITHOUT acting
 * on it (the GET confirm page; link scanners GET every URL in a mail). Valid
 * only when the sealed contact inbox still belongs to the sealed contact in
 * the sealed workspace, and the flow is that workspace's, active and
 * published (an unrunnable flow must not consume the link).
 */
export async function checkEmailFlowToken(
  token: string | null | undefined,
): Promise<Checked> {
  if (typeof token !== "string") {
    return { status: "invalid" }
  }
  let payload: Awaited<ReturnType<typeof verifyEmailFlowToken>>
  try {
    payload = await verifyEmailFlowToken(token)
  } catch {
    return { status: "invalid" }
  }
  const { servable } = await loadServableWorkspace(payload.wid)
  if (!servable) {
    return { status: "unavailable" }
  }
  const [contactInbox, flow, pageLinkLive] = await Promise.all([
    contactInboxService.findInWorkspace({
      id: payload.ciid,
      contactId: payload.cid,
      workspaceId: payload.wid,
    }),
    flowService.findActiveById({ workspaceId: payload.wid, id: payload.fid }),
    // s227a: a custom page's button lives only as long as its page link.
    payload.plid === undefined
      ? true
      : pageService.isLinkLive({
          id: payload.plid,
          workspaceId: payload.wid,
          contactId: payload.cid,
        }),
  ])
  if (!(contactInbox && flow?.currentVersionId && pageLinkLive)) {
    return { status: "invalid" }
  }
  let started: boolean
  try {
    const redis = await cacheRedis()
    // Pending (another click is starting it) reads as started too: a second
    // click could never start it twice anyway.
    started = (await redis.get(claimKey(payload.lid))) !== null
  } catch (error) {
    logger.error({ error }, "email flow link: claim store unavailable")
    return { status: "unavailable" }
  }
  return {
    status: "valid",
    workspaceId: payload.wid,
    linkId: payload.lid,
    started,
    // The flow runs on the SEALED contact inbox (Codex s222b): a contact may
    // hold two addresses on one line, and re-selecting by inbox id could
    // pick the other one.
    start: async () => {
      const conversation = await conversationService.findByContactWithInboxes({
        contactId: payload.cid,
        workspaceId: payload.wid,
      })
      if (!conversation) {
        throw new Error("the contact has no conversation to start a flow on")
      }
      await messageService.createOutgoing({
        conversation,
        contactInbox,
        input: {
          flowId: payload.fid,
          ...(payload.nid ? { nodeId: payload.nid } : {}),
          inboxId: contactInbox.inboxId,
          // BullMQ refuses a custom job id containing ":" (its key separator).
          jobId: `email-flow-start-${payload.lid}`,
        },
      })
    },
  }
}

/**
 * The POST: starts the sealed flow for the sealed contact ONCE per link. A
 * failed start releases the claim so the person can retry. `r` is the
 * email-topic recipient token, counted as a click only when it belongs to the
 * same workspace.
 */
export async function startEmailFlowByToken(
  token: string | null | undefined,
  recipientToken: string | null | undefined,
): Promise<EmailFlowStatus> {
  const checked = await checkEmailFlowToken(token)
  if (checked.status !== "valid" || !(checked.start && checked.linkId)) {
    return checked.status
  }
  const redis = await cacheRedis()
  const key = claimKey(checked.linkId)
  const owner = randomUUID()
  const claimed = await redis.set(key, owner, "EX", PENDING_TTL_SECONDS, "NX")
  if (claimed !== "OK") {
    return "started"
  }
  try {
    await checked.start()
  } catch (error) {
    await redis.eval(RELEASE_IF_OWNER, 1, key, owner)
    throw error
  }
  // Best effort from here: the flow IS queued, so nothing below may turn the
  // answer into an error (a retry would be a queue no-op anyway).
  try {
    await redis.set(key, QUEUED, "EX", QUEUED_TTL_SECONDS)
    if (recipientToken && recipientToken.length <= 256) {
      const workspaceId =
        await emailTopicService.findAnalyticsWorkspaceIdByToken({
          token: recipientToken,
        })
      if (workspaceId === checked.workspaceId) {
        await emailTopicAnalyticsService.recordClick(recipientToken)
      }
    }
  } catch (error) {
    logger.warn({ error }, "email flow link: started, bookkeeping failed")
  }
  return "started"
}
