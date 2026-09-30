/**
 * An AI-provider integration (OpenAI, Gemini, Claude, DeepSeek, OpenRouter)
 * as its settings page may hand it to a client component (s232a). The row's
 * `auth` holds the provider API key in plaintext; the settings UI only needs
 * to know whether one is stored.
 */
export type AiIntegrationSummary = {
  id: string
  autoReply: boolean
  isConnected: boolean
}

export const toAiIntegrationSummary = (
  row: { id: string; autoReply: boolean; auth?: unknown } | null | undefined,
): AiIntegrationSummary | null =>
  row
    ? { id: row.id, autoReply: row.autoReply, isConnected: Boolean(row.auth) }
    : null
