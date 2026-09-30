import {
  mergePlain,
  TemplateError,
  templateError,
  tokenNames,
} from "@chatbotx.io/email-document"
import { contactVariableService } from "@chatbotx.io/variables"
import { EmailContentError } from "./send-email-document"

type Variables = Awaited<ReturnType<typeof contactVariableService.getAll>>

/**
 * Subject, preheader and legacy element text (s227b): the SAME Liquid
 * evaluator as documents, in plain-text mode (nothing is escaped; the line
 * and SMTP builders clean headers). A template that cannot render is
 * content: EmailContentError, failed closed by the caller.
 */
export async function mergeStepText(props: {
  text: string
  variables: Variables
}): Promise<string> {
  const { text } = props
  const invalid = templateError(text, "text")
  if (invalid) {
    throw new EmailContentError(`invalid merge template: ${invalid}`)
  }
  const names = tokenNames(text)
  const vars =
    names.length > 0
      ? await contactVariableService.resolveMapping({
          text: names.map((name) => `{{${name}}}`).join(" "),
          variables: props.variables,
        })
      : {}
  try {
    return mergePlain(text, vars, new Set())
  } catch (error) {
    if (error instanceof TemplateError) {
      throw new EmailContentError(
        `merge template could not render: ${error.message}`,
        { cause: error },
      )
    }
    throw error
  }
}

/** The first legacy element text that cannot render, checked before any send. */
export function legacyElementsError(
  elements: ReadonlyArray<{ type: string; text?: unknown }>,
): string | undefined {
  for (const el of elements) {
    if (typeof el.text === "string") {
      const invalid = templateError(el.text, "text")
      if (invalid) {
        return invalid
      }
    }
  }
}
