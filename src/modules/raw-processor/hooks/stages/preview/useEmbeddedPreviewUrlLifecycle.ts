import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { ImageSession } from '../../../model/session'
import {
  clearEmbeddedPreviewUrlFromSession,
  revokeEmbeddedPreviewObjectUrls,
} from '../../../services/preview/embedded-preview-url'

export type SetImageSession = (
  update:
    | ImageSession
    | null
    | ((prev: ImageSession | null) => ImageSession | null),
) => void

type UseEmbeddedPreviewUrlLifecycleInput = {
  embeddedPreviewUrlRef: MutableRefObject<string | null>
  /** Reads the current session from the store, not from the last render. */
  getSession: () => ImageSession | null
  setSession: SetImageSession
  revokeObjectUrls?: typeof revokeEmbeddedPreviewObjectUrls
}

export function useEmbeddedPreviewUrlLifecycle({
  embeddedPreviewUrlRef,
  getSession,
  setSession,
  revokeObjectUrls = revokeEmbeddedPreviewObjectUrls,
}: UseEmbeddedPreviewUrlLifecycleInput) {
  const clearSessionEmbeddedPreviewUrl = useCallback(
    (sessionId?: string) => {
      setSession((prev) => {
        if (!prev || (sessionId && prev.id !== sessionId)) {
          return prev
        }

        if (!prev.previewBundle.embeddedPreview.objectUrl) {
          return prev
        }

        return clearEmbeddedPreviewUrlFromSession(prev)
      })
    },
    [setSession],
  )

  // One read of the store names both the session URL revoked and the session
  // cleared, so they are the same source's: never a URL of an older render's
  // source, never a cleanup keyed to it. Without a source no session is
  // touched.
  const revokeCurrentEmbeddedPreviewUrl = useCallback(() => {
    const session = getSession()
    const urls = new Set(
      [
        embeddedPreviewUrlRef.current,
        session?.previewBundle.embeddedPreview.objectUrl,
      ].filter((url): url is string => Boolean(url)),
    )

    revokeObjectUrls(urls)

    embeddedPreviewUrlRef.current = null
    if (session) {
      clearSessionEmbeddedPreviewUrl(session.id)
    }
  }, [
    clearSessionEmbeddedPreviewUrl,
    embeddedPreviewUrlRef,
    getSession,
    revokeObjectUrls,
  ])

  return {
    clearSessionEmbeddedPreviewUrl,
    revokeCurrentEmbeddedPreviewUrl,
  }
}
