"use client"

import { useSyncExternalStore } from "react"

// Nothing to subscribe to: the value only flips once, at hydration.
const subscribe = () => () => undefined

/**
 * False on the server render and during hydration, true after. For output
 * that depends on the process's clock or zone and so cannot match between the
 * server and the browser (React #418): render a zone-free stand-in until this
 * is true.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  )
}
