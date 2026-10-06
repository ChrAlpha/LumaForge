import { useCallback, useEffect, useRef, useState } from 'react'

import type { SourceInterruptionHint } from '../../../services/export/export-recovery'
import {
  getExportInterruptionMarkers,
  readSourceInterruption,
} from '../../../services/export/export-recovery'

/**
 * The page's interruption hint for the loaded source, read from the page's
 * markers. It is the only interruption state: the next explicit export and
 * the note surfaces show both come from it. Loading a source, reading a hint
 * or a readiness change never starts an export; the hint only waits for the
 * next export the user starts.
 */
export function useExportInterruptionState(sourceFile: File | null) {
  const interruptionMarkers = getExportInterruptionMarkers()
  const exportInterruptionRef = useRef<SourceInterruptionHint | null>(null)
  const [exportInterruption, setInterruption] =
    useState<SourceInterruptionHint | null>(null)
  // Bumped after an export ends so the hint is read again.
  const [interruptionCheck, setInterruptionCheck] = useState(0)

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

  useEffect(() => {
    if (!sourceFile) {
      setExportInterruption(null)
      return
    }

    let cancelled = false
    readSourceInterruption(interruptionMarkers, sourceFile).then(
      (next) => {
        if (!cancelled) setExportInterruption(next)
      },
      () => {
        if (!cancelled) setExportInterruption(null)
      },
    )

    return () => {
      cancelled = true
    }
  }, [
    interruptionCheck,
    interruptionMarkers,
    setExportInterruption,
    sourceFile,
  ])

  return {
    interruptionMarkers,
    exportInterruption,
    exportInterruptionRef,
    refreshExportInterruption,
  }
}
