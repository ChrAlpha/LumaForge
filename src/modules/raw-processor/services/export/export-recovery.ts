import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import { sourceFingerprintMatches } from '~/lib/export/source-fingerprint'

import type { ExportRecoveryState } from '../../model/session'
import {
  isAbortError,
  isRetryableFullResExportFailure,
} from '../ingest/workflow-status'
import type {
  ExportAttemptOutcome,
  ExportInterruptionHint,
  ExportSourceTuple,
} from './export-interruption'
import {
  createExportInterruptionMarkers,
  encodeExportSourceHint,
} from './export-interruption'

export type ExportInterruptionMarkers = ReturnType<
  typeof createExportInterruptionMarkers
>

/**
 * The interruption hint read for one source tuple. It belongs to that tuple
 * alone: another file never inherits its safer plan.
 */
export type SourceInterruptionHint = {
  /** The encoded file tuple the hint was read for. */
  source: string
  hint: ExportInterruptionHint
}

type ExplicitExportChoice = {
  quality: 'standard' | 'high'
  fidelity: 'safe' | 'balanced' | 'max'
}

type ExplicitExportRequest = ExplicitExportChoice & {
  interruption?: SourceInterruptionHint
}

const INTERRUPTION_MESSAGE =
  'The browser interrupted the previous export. Your next export will use a safer low-memory setting.'

let pageMarkers: ExportInterruptionMarkers | null = null

/**
 * The page's one marker owner. Every export attempt and every hint read on
 * the page goes through it, so the page holds one owner lock for its life.
 */
export function getExportInterruptionMarkers() {
  pageMarkers ??= createExportInterruptionMarkers()
  return pageMarkers
}

export function toExportSourceTuple(file: File): ExportSourceTuple {
  return { name: file.name, size: file.size, lastModified: file.lastModified }
}

function hasInterruption(hint: ExportInterruptionHint) {
  return hint.previousCrashLikeInterruption || hint.previousResourceFailure
}

/**
 * Reads the hint for a loaded source. It only reads: nothing here starts,
 * resumes or sizes an export.
 */
export async function readSourceInterruption(
  markers: Pick<ExportInterruptionMarkers, 'inspect'>,
  file: File,
): Promise<SourceInterruptionHint | null> {
  const tuple = toExportSourceTuple(file)
  const source = encodeExportSourceHint(tuple)
  if (source === null) return null
  const hint = await markers.inspect(tuple)
  return hasInterruption(hint) ? { source, hint } : null
}

/** The hint when it was read for this file's tuple, otherwise null. */
export function interruptionForSource(
  interruption: SourceInterruptionHint | null | undefined,
  file: File | null,
): ExportInterruptionHint | null {
  if (!interruption || !file || !hasInterruption(interruption.hint)) {
    return null
  }
  return encodeExportSourceHint(toExportSourceTuple(file)) ===
    interruption.source
    ? interruption.hint
    : null
}

/**
 * The read-only recovery state surfaces still read, projected from the same
 * hint the next explicit export uses. Only a crash-like interruption reads
 * as one; a resource failure already reported its own error. It names no
 * source and no dimensions.
 */
export function projectExportRecovery(
  interruption: SourceInterruptionHint | null | undefined,
  file: File | null,
): ExportRecoveryState {
  const hint = interruptionForSource(interruption, file)
  if (!hint?.previousCrashLikeInterruption) return { status: 'none' }
  return {
    status: 'ready-to-retry',
    exportId: hint.attempts[0] ?? '',
    message: INTERRUPTION_MESSAGE,
  }
}

/**
 * The same read-only hint for a journal an older build left behind. It says
 * only that an export was interrupted: it asks for neither the source nor
 * its dimensions and never starts an export.
 */
export function createInterruptedExportRecovery(
  manifest: ExportCheckpointManifest,
): Extract<ExportRecoveryState, { status: 'ready-to-retry' }> {
  return {
    status: 'ready-to-retry',
    exportId: manifest.exportId,
    message: INTERRUPTION_MESSAGE,
  }
}

/**
 * Builds the request for an export the user started: the current quality
 * and fidelity, plus the hint read for the loaded source. The export applies
 * the hint only when it matches the file it actually renders.
 */
export function withInterruptionHistory(
  choice: ExplicitExportChoice,
  interruption: SourceInterruptionHint | null | undefined,
): ExplicitExportRequest {
  const request: ExplicitExportRequest = {
    quality: choice.quality,
    fidelity: choice.fidelity,
  }
  return interruption ? { ...request, interruption } : request
}

/**
 * How a failed attempt ended. A cancellation is not an interruption; only a
 * failure a lighter plan addresses counts as a resource failure.
 */
export function classifyExportAttemptOutcome(input: {
  aborted: boolean
  errorCode: string
  error?: unknown
}): Exclude<ExportAttemptOutcome, 'completed'> {
  if (input.aborted || isAbortError(input.error)) return 'cancelled'
  return isRetryableFullResExportFailure(input.errorCode)
    ? 'resource-failure'
    : 'failed'
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
