import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { sourceFingerprintMatches } from '~/lib/export/source-fingerprint'

import type { ExportRecoveryState } from '../../model/session'

type ExportInterruptionHint = Extract<
  ExportRecoveryState,
  { status: 'ready-to-retry' }
>

type ExplicitExportChoice = {
  quality: 'standard' | 'high'
  fidelity: 'safe' | 'balanced' | 'max'
}

type ExplicitExportRequest = ExplicitExportChoice & {
  previousInterrupted?: true
  recoveredExportId?: string
}

/**
 * A journal left by an interrupted export only says that an export was
 * interrupted. It cannot reproduce the look it was rendering, so it asks for
 * neither the source nor its dimensions and never starts an export itself.
 */
export function createInterruptedExportRecovery(
  manifest: ExportCheckpointManifest,
): ExportInterruptionHint {
  return {
    status: 'ready-to-retry',
    exportId: manifest.exportId,
    message:
      'The browser interrupted the previous export. Your next export will use a safer low-memory setting.',
  }
}

/**
 * Builds the request for an export the user started. Interruption history
 * only asks the planner for its safer interrupted-retry plan: quality and
 * fidelity are the current choice, and without a journal the plan sizes
 * itself from the current source while the graph renders the current look.
 * `recoveredExportId` lets a successful export retire the interrupted journal.
 */
export function withInterruptionHistory(
  choice: ExplicitExportChoice,
  ...recoveries: ReadonlyArray<ExportRecoveryState | null | undefined>
): ExplicitExportRequest {
  const request: ExplicitExportRequest = {
    quality: choice.quality,
    fidelity: choice.fidelity,
  }
  const interruption = recoveries.find(
    (recovery) => recovery && recovery.status !== 'none',
  )
  if (!interruption || interruption.status === 'none') return request

  return {
    ...request,
    previousInterrupted: true,
    recoveredExportId: interruption.exportId,
  }
}

export async function validateRecoveryReselection(
  file: File,
  manifest: ExportCheckpointManifest,
) {
  const ok = await sourceFingerprintMatches(file, manifest.sourceFingerprint, {
    width: manifest.outputWidth,
    height: manifest.outputHeight,
  })

  return ok
    ? { ok: true as const }
    : {
        ok: false as const,
        reason:
          'The selected RAW does not match the interrupted export source.',
      }
}
