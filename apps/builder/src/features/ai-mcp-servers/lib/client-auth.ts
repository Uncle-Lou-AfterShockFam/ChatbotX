import { aiMcpServerAuth } from "@chatbotx.io/database/partials"
import { VARIABLE_PLACEHOLDER_SOURCE } from "@chatbotx.io/utils/variables"
import { parseBotFieldVariableText } from "@chatbotx.io/variables/bot-field-variable"
import type { AIMcpServerClientAuth } from "../schema/resource"

const PLACEHOLDER_PATTERN = new RegExp(VARIABLE_PLACEHOLDER_SOURCE, "g")

/**
 * True for a token made only of `{{bot_field:<id>}}` references: the secret
 * is the bot field's value, so the reference itself may be shown. Any static
 * text (a raw token, or a prefix next to a reference) may be the secret.
 */
const isBotFieldReferenceOnly = (token: string): boolean => {
  const parsed = parseBotFieldVariableText(token)
  return (
    parsed.status === "valid" &&
    parsed.fieldIds.length > 0 &&
    token.replace(PLACEHOLDER_PATTERN, "").trim() === ""
  )
}

/**
 * The stored MCP `auth` reduced to what a builder client may see (s232a):
 * header names without values, and the token only when it is a bot-field
 * reference. A value that does not parse as MCP auth reads as `none`, so a
 * malformed row never leaks.
 */
export const toClientAuth = (stored: unknown): AIMcpServerClientAuth => {
  const parsed = aiMcpServerAuth.safeParse(stored)
  if (!parsed.success) {
    return { type: "none" }
  }
  const auth = parsed.data
  switch (auth.type) {
    case "none":
      return { type: "none" }
    case "token":
      return {
        type: "token",
        token: isBotFieldReferenceOnly(auth.token) ? auth.token : "",
      }
    case "header":
      return {
        type: "header",
        headers: auth.headers.map(({ header }) => ({ header, value: "" })),
      }
    default:
      return { type: "none" }
  }
}

export const withClientAuth = <T extends { auth: unknown }>(
  row: T,
): Omit<T, "auth"> & { auth: AIMcpServerClientAuth } => ({
  ...row,
  auth: toClientAuth(row.auth),
})
