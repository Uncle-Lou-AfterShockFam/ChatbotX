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
  WEBCHAT_TOKEN_REFRESH_LEAD_MS,
  webchatTokenExpiresAtMs,
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
  // refresh shortly before expiry, again when a sleeping tab wakes up late,
  // and reschedule from each new token.
  useEffect(() => {
    const store = storeRef.current
    if (!store) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    const refresh = async () => {
      if (await store.getState().refreshAccessToken()) {
        retries = 0
        return // the token change reschedules
      }
      if (retries < MAX_REFRESH_RETRIES) {
        retries += 1
        clearTimeout(timer)
        timer = setTimeout(refresh, REFRESH_RETRY_MS)
      }
    }
    const schedule = () => {
      clearTimeout(timer)
      const delay = webchatTokenRefreshDelayMs(
        store.getState().accessToken,
        Date.now(),
      )
      if (delay !== null) {
        timer = setTimeout(refresh, delay)
      }
    }
    const onVisible = () => {
      const expiresAt = webchatTokenExpiresAtMs(store.getState().accessToken)
      if (
        document.visibilityState === "visible" &&
        expiresAt !== null &&
        expiresAt - Date.now() <= WEBCHAT_TOKEN_REFRESH_LEAD_MS
      ) {
        refresh().catch(() => undefined)
      }
    }
    schedule()
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.accessToken !== previous.accessToken) {
        schedule()
      }
    })
    document.addEventListener("visibilitychange", onVisible)
    return () => {
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
