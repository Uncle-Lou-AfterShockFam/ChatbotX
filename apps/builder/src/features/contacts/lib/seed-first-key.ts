/** Stable identity of a list input (the query key's input part). */
export const listInputKey = (input: unknown): string => JSON.stringify(input)

/**
 * The RSC-fetched first page seeds ONLY the query key it was fetched for;
 * any other key (a new filter / page / sort) must fetch.
 */
export const seedForFirstKey = <T>(
  currentKey: string,
  initialKey: string,
  initial: T,
): T | undefined => (currentKey === initialKey ? initial : undefined)
