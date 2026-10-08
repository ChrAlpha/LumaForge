import { useCallback } from 'react'

import type { LUTContractSelectionState, StyleAsset } from '../model/session'
import { createImageSession } from '../model/session-factory'
import { useCurrentSession } from '../state/session.atoms'

export function useImageSession() {
  const [session, setSession] = useCurrentSession()

  const replaceFile = useCallback(
    (
      file: File,
      retained?: {
        activeStyle?: StyleAsset | null
        lutProfileSelection?: LUTContractSelectionState
      },
    ) => {
      const nextSession = createImageSession(file, retained)
      setSession(nextSession)
      return nextSession
    },
    [setSession],
  )

  const resetSession = useCallback(() => {
    setSession(null)
  }, [setSession])

  const setActiveStyle = useCallback(
    (style: StyleAsset | null) => {
      setSession((prev) => (prev ? { ...prev, activeStyle: style } : prev))
    },
    [setSession],
  )

  return { session, replaceFile, resetSession, setActiveStyle, setSession }
}
