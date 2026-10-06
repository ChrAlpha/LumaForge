import { useCallback, useRef, useState } from 'react'

import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import { getExportInterruptionMarkers } from '../../../services/export/export-recovery'
import type { PendingRecoveryRetry } from './useExportRecoveryAction'

/**
 * The page's interruption hint for the loaded source, read from the page's
 * markers. It is the only interruption state: the next explicit export and
 * the read-only recovery projection both come from it.
 */
export function useExportRecoveryState() {
  const interruptionMarkers = getExportInterruptionMarkers()
  const exportInterruptionRef = useRef<SourceInterruptionHint | null>(null)
  const [exportInterruption, setInterruption] =
    useState<SourceInterruptionHint | null>(null)
  const [interruptionCheck, setInterruptionCheck] = useState(0)
  const [pendingRecoveryRetry, setPendingRecoveryRetry] =
    useState<PendingRecoveryRetry | null>(null)

  const setExportInterruption = useCallback(
    (next: SourceInterruptionHint | null) => {
      exportInterruptionRef.current = next
      setInterruption(next)
    },
    [],
  )
  const refreshExportInterruption = useCallback(() => {
    setInterruptionCheck((check) => check + 1)
  }, [])

  return {
    interruptionMarkers,
    exportInterruption,
    exportInterruptionRef,
    setExportInterruption,
    interruptionCheck,
    refreshExportInterruption,
    pendingRecoveryRetry,
    setPendingRecoveryRetry,
  }
}
