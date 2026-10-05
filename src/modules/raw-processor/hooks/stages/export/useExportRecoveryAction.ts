import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback } from 'react'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'

import type { ExportRecoveryState, ImageSession } from '../../../model/session'
import type { ProcessingStatus } from '../../../model/workflow'

export type PendingRecoveryRetry = {
  sourceExportId: string
  manifest: ExportCheckpointManifest
  sessionId: string
  fileName: string
  size: number
  lastModified: number
}

type ExportRecoveryToast = {
  error: (message: string, options?: { description?: string }) => void
}

type ExportImageForRecovery = (options: {
  quality: 'standard' | 'high'
  fidelity: 'safe' | 'balanced' | 'max'
  previousInterrupted?: boolean
  recoveredExportId?: string
  recoveredManifest?: ExportCheckpointManifest
}) => Promise<void>

type UseExportRecoveryActionInput = {
  pendingRecoveryRetry: PendingRecoveryRetry | null
  setPendingRecoveryRetry: Dispatch<SetStateAction<PendingRecoveryRetry | null>>
  sessionRef: MutableRefObject<ImageSession | null>
  discoveredRecoveryRef: MutableRefObject<ExportRecoveryState>
  loadedFile: File | null
  canExport: boolean
  status: ProcessingStatus
  loadFile: (file: File) => Promise<void>
  exportImage: ExportImageForRecovery
  scheduleToast: (notify: () => void) => void
  toast?: ExportRecoveryToast
}

/**
 * An interrupted export is only a hint for the next export the user starts.
 * Picking a file here neither reselects nor reloads a source, and no pending
 * retry, source load or readiness change may start an export on its own.
 */
export function useExportRecoveryAction(_input: UseExportRecoveryActionInput) {
  const recoverInterruptedExport = useCallback(async (_file: File) => {}, [])

  return { recoverInterruptedExport }
}
