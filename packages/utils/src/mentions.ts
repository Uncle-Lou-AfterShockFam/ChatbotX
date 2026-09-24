/**
 * Deal-comment @mention tokens (s193): `@[Label](u:<userId>)`. Pure: the
 * caller validates the ids against the workspace / pipeline members. A
 * malformed token stays plain text; duplicates collapse to the first label.
 */
export type MentionRef = { userId: string; label: string }

export const MENTION_LABEL_MAX = 60
// label: no `]`, no newline, <= 60; id: digits only (bigint-as-string)
const MENTION_TOKEN = /@\[([^\]\n]{1,60})\]\(u:(\d{1,20})\)/g

export function parseMentions(body: string): MentionRef[] {
  if (typeof body !== "string" || body.length === 0) {
    return []
  }
  const seen = new Map<string, MentionRef>()
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const userId = match[2]
    if (!seen.has(userId)) {
      seen.set(userId, { userId, label: match[1].trim() })
    }
  }
  return [...seen.values()]
}

/** The body with every token replaced by `@Label` (activity lines, texts). */
export function renderMentionsPlain(body: string): string {
  if (typeof body !== "string") {
    return ""
  }
  return body.replace(MENTION_TOKEN, (_m, label: string) => `@${label.trim()}`)
}

/** Build one token; the label is clipped and stripped of `]` / newlines. */
export function mentionToken(ref: MentionRef): string {
  const label = ref.label
    .replace(/[\]\n\r]/g, " ")
    .trim()
    .slice(0, MENTION_LABEL_MAX)
  return `@[${label || ref.userId}](u:${ref.userId})`
}
