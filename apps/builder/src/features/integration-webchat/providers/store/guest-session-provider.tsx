"use client"

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react"
import { useStore } from "zustand"
import {
  isWebchatTokenDue,
  webchatTokenRefreshDelayMs,
} from "../../lib/webchat-token-expiry"
import {
  createGuestSessionStore,
  type GuestSessionStore,
} from "./guest-sesssion-store"
import type { WebchatClientConfig } from "./lib/webchat-client-config"

// A failed (not refused) refresh is retried this often, at most this many times.
const REFRESH_RETRY_MS = 60 * 1000
const MAX_REFRESH_RETRIES = 3

export type GuestSessionStoreApi = ReturnType<typeof createGuestSessionStore>

export const GuestSessionStoreContext = createContext<
  GuestSessionStoreApi | undefined
>(undefined)

export type GuestSessionStoreProviderProps = {
  children: ReactNode
  config: WebchatClientConfig
  accessToken?: string | null
  /** The server-seen embedding origin; see GuestSessionState.parentOrigin. */
  parentOrigin?: string | null
  serverGuestConversationId: string
  /** Resolved server-side; see GuestSessionState.workspaceLogoUrl. */
  workspaceLogoUrl?: string
}

export const GuestSessionStoreProvider = ({
  children,
  config,
  accessToken = null,
  parentOrigin = null,
  serverGuestConversationId,
  workspaceLogoUrl,
}: GuestSessionStoreProviderProps) => {
  const storeRef = useRef<GuestSessionStoreApi>(null)
  if (!storeRef.current) {
    storeRef.current = createGuestSessionStore(
      config,
      accessToken,
      workspaceLogoUrl,
      parentOrigin,
    )
  }

  useEffect(() => {
    storeRef.current?.getState().initGuestSession(serverGuestConversationId)
  }, [serverGuestConversationId])

  // Keep the 30-minute guest token fresh while the widget stays open (s210):
  // refresh shortly before it lapses (timed from when it arrived, so client
  // clock skew is irrelevant), again when a tab wakes up late, and reschedule
  // from each new token. Only failures are retried, a bounded number of times.
  useEffect(() => {
    const store = storeRef.current
    if (!store) {
      return
    }
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    const arm = (delay: number) => {
      clearTimeout(timer)
      timer = disposed ? undefined : setTimeout(refresh, delay)
    }
    // The timer and a wake-up can fire together: one run at a time, so one
    // failure costs one retry.
    let running = false
    const refresh = async () => {
      if (running) {
        return
      }
      running = true
      try {
        const outcome = await store.getState().refreshAccessToken()
        // "refreshed" reschedules through the subscription below.
        if (
          !disposed &&
          outcome === "failed" &&
          retries < MAX_REFRESH_RETRIES
        ) {
          retries += 1
          arm(REFRESH_RETRY_MS)
        }
      } finally {
        running = false
      }
    }
    const schedule = () =>
      arm(
        webchatTokenRefreshDelayMs(
          store.getState().accessTokenReceivedAt,
          Date.now(),
        ),
      )
    const onVisible = () => {
      if (
        document.visibilityState === "visible" &&
        isWebchatTokenDue(store.getState().accessTokenReceivedAt, Date.now())
      ) {
        refresh().catch(() => undefined)
      }
    }
    schedule()
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.accessTokenReceivedAt !== previous.accessTokenReceivedAt) {
        retries = 0
        schedule()
      }
    })
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      disposed = true
      clearTimeout(timer)
      unsubscribe()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return (
    <GuestSessionStoreContext.Provider value={storeRef.current}>
      {children}
    </GuestSessionStoreContext.Provider>
  )
}

export const useGuestSessionStore = <T,>(
  selector: (store: GuestSessionStore) => T,
): T => {
  const guestSessionStoreContext = useContext(GuestSessionStoreContext)

  if (!guestSessionStoreContext) {
    throw new Error(
      "useGuestSessionStore must be used within GuestSessionStoreProvider",
    )
  }

  return useStore(guestSessionStoreContext, selector)
}
