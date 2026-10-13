import type { MutableRefObject } from 'react'
import { useCallback } from 'react'

import type { ImageSession } from '../../../model/session'
import {
  clearEmbeddedPreviewUrlFromSession,
  revokeEmbeddedPreviewObjectUrls,
} from '../../../services/preview/embedded-preview-url'
import type { SetImageSession } from '../../../state/session.atoms'

type UseEmbeddedPreviewUrlLifecycleInput = {
  embeddedPreviewUrlRef: MutableRefObject<string | null>
  /** Reads the current session from the store, not from the last render. */
  getSession: () => ImageSession | null
  setSession: SetImageSession
}

export function useEmbeddedPreviewUrlLifecycle({
  embeddedPreviewUrlRef,
  getSession,
  setSession,
}: UseEmbeddedPreviewUrlLifecycleInput) {
  // One read of the store names both the session URL revoked and the session
  // cleared, so they are the same source's: never a URL of an older render's
  // source, never a cleanup keyed to it. Without a source no session is
  // touched. An owner that names its session (a departing mount) releases the
  // URL it holds itself, and the stored session's only while that session is
  // the one it names: a session another mount has published since keeps its
  // URL and preview.
  const revokeCurrentEmbeddedPreviewUrl = useCallback(
    (ownerSessionId?: string | null) => {
      const current = getSession()
      const session =
        ownerSessionId === undefined || current?.id === ownerSessionId
          ? current
          : null
      const urls = new Set(
        [
          embeddedPreviewUrlRef.current,
          session?.previewBundle.embeddedPreview.objectUrl,
        ].filter((url): url is string => Boolean(url)),
      )

      revokeEmbeddedPreviewObjectUrls(urls)

      embeddedPreviewUrlRef.current = null
      if (!session) return
      setSession((prev) =>
        prev?.id === session.id && prev.previewBundle.embeddedPreview.objectUrl
          ? clearEmbeddedPreviewUrlFromSession(prev)
          : prev,
      )
    },
    [embeddedPreviewUrlRef, getSession, setSession],
  )

  return { revokeCurrentEmbeddedPreviewUrl }
}
