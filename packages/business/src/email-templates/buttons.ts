import type { LeafBlock } from "@chatbotx.io/email-document"
import {
  openWebsiteStepSchema,
  type PageElementSchema,
  startAnotherNodeStepSchema,
  startExternalFlowStepSchema,
  startExternalNodeStepSchema,
} from "@chatbotx.io/flow-config"
import { signEmailFlowToken } from "../email-topic/flow-url"

/**
 * A document flow button's beforeStep, validated by the SAME flow-config
 * schema a legacy button uses, per its stepType; anything else is dropped.
 */
const BUTTON_STEPS = {
  openWebsite: openWebsiteStepSchema,
  startExternalFlow: startExternalFlowStepSchema,
  startExternalNode: startExternalNodeStepSchema,
  startAnotherNode: startAnotherNodeStepSchema,
} as const

export type DocumentFlowButton = Extract<PageElementSchema, { type: "button" }>

/**
 * A document button with a `flow` action as the legacy page-element button
 * the send paths already resolve (email step, custom pages); undefined for a
 * URL button or a beforeStep that fails its schema.
 */
export function documentFlowButton(
  leaf: Extract<LeafBlock, { type: "button" }>,
): DocumentFlowButton | undefined {
  if (leaf.action.kind !== "flow") {
    return
  }
  const stepType = String(leaf.action.beforeStep.stepType ?? "")
  if (!Object.hasOwn(BUTTON_STEPS, stepType)) {
    return
  }
  const buttonType = stepType as keyof typeof BUTTON_STEPS
  const parsed = BUTTON_STEPS[buttonType].safeParse(leaf.action.beforeStep)
  if (!parsed.success) {
    return
  }
  return {
    id: leaf.id,
    type: "button",
    label: leaf.label,
    buttonType,
    beforeStep: parsed.data,
    steps: [],
  } as DocumentFlowButton
}

/**
 * A start-flow / start-node button as a sealed `/email-topic/flow` link for
 * one contact + contact inbox: its confirm POST starts the flow (a scanner's
 * GET never does). `ref` is the email topic token (click attribution);
 * `pageLink` binds the link to a custom page link (s227a). Undefined for any
 * other button type.
 */
export async function sealedFlowButtonUrl(props: {
  appUrl: string
  button: DocumentFlowButton
  workspaceId: string
  contact: { id: string; contactInboxId: string }
  ref?: string
  pageLink?: Parameters<typeof signEmailFlowToken>[0]["pageLink"]
}): Promise<string | undefined> {
  const { button } = props
  if (
    button.buttonType !== "startExternalFlow" &&
    button.buttonType !== "startExternalNode"
  ) {
    return
  }
  const sealed = await signEmailFlowToken({
    workspaceId: props.workspaceId,
    flowId: button.beforeStep.flowId,
    ...(button.buttonType === "startExternalNode"
      ? { nodeId: button.beforeStep.nodeId }
      : {}),
    contactId: props.contact.id,
    contactInboxId: props.contact.contactInboxId,
    ...(props.pageLink ? { pageLink: props.pageLink } : {}),
  })
  const query = new URLSearchParams({ t: sealed })
  if (props.ref) {
    query.set("r", props.ref)
  }
  return `${props.appUrl}/email-topic/flow?${query.toString()}`
}
