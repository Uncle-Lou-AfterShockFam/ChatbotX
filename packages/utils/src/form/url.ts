/** URL checks shared by the definition (chat media) and the evaluator (answers). */
const protocolOf = (value: string): string | null => {
  try {
    return new URL(value).protocol
  } catch {
    return null
  }
}

export const isHttpUrl = (value: string): boolean => {
  const protocol = protocolOf(value)
  return protocol === "https:" || protocol === "http:"
}

export const isHttpsUrl = (value: string): boolean =>
  protocolOf(value) === "https:"
