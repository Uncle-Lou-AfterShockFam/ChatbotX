import type { LeafBlock } from "@chatbotx.io/email-document"
import {
  openWebsiteStepSchema,
  type PageElementSchema,
  startAnotherNodeStepSchema,
  startExternalFlowStepSchema,
  startExternalNodeStepSchema,
} from "@chatbotx.io/flow-config"

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
