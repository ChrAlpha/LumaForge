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

type ExplicitExportRequest = {
  interruption?: SourceInterruptionHint
}

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
 * Whether surfaces note an interrupted export for this file, read from the
 * same hint the next explicit export uses. Only a crash-like interruption
 * reads as one; a resource failure already reported its own error.
 */
export function isInterruptedSource(
  interruption: SourceInterruptionHint | null | undefined,
  file: File | null,
): boolean {
  return (
    interruptionForSource(interruption, file)?.previousCrashLikeInterruption ===
    true
  )
}

/**
 * Builds the request for an export the user started: only the hint read for
 * the loaded source. It carries no quality, which is fixed, and the export
 * applies the hint only when it matches the file it actually renders.
 */
export function withInterruptionHistory(
  interruption: SourceInterruptionHint | null | undefined,
): ExplicitExportRequest {
  return interruption ? { interruption } : {}
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
