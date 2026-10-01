/**
 * s234a (owner decision 2026-10-01): the flow LIST route feeds the flow
 * pickers on screens a member without `flows` uses (broadcasts, sequences,
 * triggers, the inbox "send flow", comments, QR codes, ...). Such a member
 * gets each version's nodes reduced to what those pickers read - the node
 * id, type and name, and on a start node its template-bound steps
 * (`findTemplateStartStep`: `stepType` + `template.id`) - and no edges.
 * Step config (messages, requests, conditions) stays behind `flows`.
 */

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

/** The start node's template-bound steps, reduced to stepType + template id. */
const templateSteps = (data: JsonRecord): JsonRecord[] => {
  const details = data.details
  if (!(isRecord(details) && Array.isArray(details.steps))) {
    return []
  }
  return details.steps.flatMap((step: unknown) => {
    if (!isRecord(step)) {
      return []
    }
    const stepType = asString(step.stepType)
    const templateId = isRecord(step.template)
      ? asString(step.template.id)
      : undefined
    return stepType && templateId
      ? [{ stepType, template: { id: templateId } }]
      : []
  })
}

export const toFlowPickerNode = (node: {
  id: string
  [x: string]: unknown
}): { id: string; [x: string]: unknown } => {
  const data = isRecord(node.data) ? node.data : {}
  const name = asString(data.name)
  const type = asString(node.type)
  return {
    id: node.id,
    ...(type === undefined ? {} : { type }),
    data: {
      ...(name === undefined ? {} : { name }),
      ...(data.isStartNode === true
        ? { isStartNode: true, details: { steps: templateSteps(data) } }
        : {}),
    },
  }
}

/** A listed flow as a member without `flows` may see it. */
export const toFlowPickerResource = <
  T extends {
    flowVersions: {
      nodes: { id: string; [x: string]: unknown }[]
      edges: { id: string; [x: string]: unknown }[]
    }[]
  },
>(
  flow: T,
): T => ({
  ...flow,
  flowVersions: flow.flowVersions.map((version) => ({
    ...version,
    nodes: version.nodes.map(toFlowPickerNode),
    edges: [],
  })),
})
