import { useEffect } from 'react'

import type {
  ExportInterruptionMarkers,
  SourceInterruptionHint,
} from '../../../services/export/export-recovery'
import { readSourceInterruption } from '../../../services/export/export-recovery'

type UseExportRecoveryDiscoveryInput = {
  /** The loaded source; without one there is no hint to read. */
  sourceFile: File | null
  /** Bumped after an export ends so the hint is read again. */
  interruptionCheck: number
  markers: Pick<ExportInterruptionMarkers, 'inspect'>
  setExportInterruption: (next: SourceInterruptionHint | null) => void
}

/**
 * Reads the interruption hint for the loaded source tuple. Loading a source,
 * reading a hint or a readiness change never starts an export; the hint only
 * waits for the next export the user starts.
 */
export function useExportRecoveryDiscovery({
  sourceFile,
  interruptionCheck,
  markers,
  setExportInterruption,
}: UseExportRecoveryDiscoveryInput) {
  useEffect(() => {
    if (!sourceFile) {
      setExportInterruption(null)
      return
    }

    let cancelled = false
    readSourceInterruption(markers, sourceFile).then(
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
  }, [interruptionCheck, markers, setExportInterruption, sourceFile])
}
