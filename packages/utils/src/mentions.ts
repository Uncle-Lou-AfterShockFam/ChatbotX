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

export type MentionPart =
  | { kind: "text"; text: string }
  | { kind: "mention"; userId: string; label: string }

/** The body split into text runs and mention tokens, in order (for rendering chips). */
export function splitMentions(body: string): MentionPart[] {
  if (typeof body !== "string" || body.length === 0) {
    return []
  }
  const parts: MentionPart[] = []
  let cursor = 0
  for (const match of body.matchAll(MENTION_TOKEN)) {
    const start = match.index ?? 0
    if (start > cursor) {
      parts.push({ kind: "text", text: body.slice(cursor, start) })
    }
    parts.push({ kind: "mention", userId: match[2], label: match[1].trim() })
    cursor = start + match[0].length
  }
  if (cursor < body.length) {
    parts.push({ kind: "text", text: body.slice(cursor) })
  }
  return parts
}

/** Clip to `max` code points (never splits a surrogate pair), with an ellipsis. */
export function clipText(value: string, max: number): string {
  const points = Array.from(value)
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : value
}
