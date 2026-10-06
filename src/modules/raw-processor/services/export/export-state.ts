import type {
  ProcessingParams,
  RawRenderExposure,
} from '@lumaforge/luma-color-runtime'
import { normalizeSelectiveColorParams } from '@lumaforge/luma-color-runtime'
import type { LumaRawExportCapability } from '@lumaforge/luma-raw-runtime'

import type { ExportCheckpointManifest } from '~/lib/export/checkpoint-store'
import type { FullResWorkerCheckpointMetric } from '~/lib/export/full-res-export-client'

import type { ImageSession } from '../../model/session'

export function toFullResCapabilityState(capability: LumaRawExportCapability) {
  if (
    capability.supported &&
    capability.strategy === 'libraw-processed-window' &&
    capability.windows.librawProcessed
  ) {
    return {
      status: 'supported' as const,
      width: capability.width,
      height: capability.height,
    }
  }

  return {
    status: 'unsupported' as const,
    reason: capability.supported
      ? 'processed-window-unavailable'
      : capability.reasons.join(', ') ||
        'This RAW source does not support full-resolution export in the current browser build.',
  }
}

export function buildExportFailureDescription(
  message: string,
  retryLevel: 'safe' | 'balanced' | null,
) {
  if (!retryLevel) {
    return message
  }

  return `${message}. Retry with ${retryLevel} fidelity.`
}

export function createSafeRetryManifest(input: {
  exportId: string
  file: File
  sourceFingerprint: ExportCheckpointManifest['sourceFingerprint']
  outputWidth: number
  outputHeight: number
  graphFingerprint: string
  profile: ExportCheckpointManifest['profile']
  derivedLabel: string
  preferredRows: number
  outputSink: ExportCheckpointManifest['outputSink']
  completedRowsForDiagnostics?: number
  updatedAt?: string
}): ExportCheckpointManifest {
  return {
    version: 1,
    exportId: input.exportId,
    sourceFingerprint: input.sourceFingerprint,
    fileName: input.file.name,
    sourceSize: input.file.size,
    sourceLastModified: input.file.lastModified,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    graphFingerprint: input.graphFingerprint,
    profile: input.profile,
    derivedLabel: input.derivedLabel,
    attempt: 1,
    preferredRows: input.preferredRows,
    totalRows: input.outputHeight,
    recoveryMode: 'safe-retry',
    outputSink: input.outputSink,
    sourceReacquisition: 'user-reselect-required',
    completedRowsForDiagnostics: input.completedRowsForDiagnostics ?? 0,
    jpegState: 'restart-required',
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  }
}

export function isCheckpointMetric(
  metric: unknown,
): metric is FullResWorkerCheckpointMetric {
  return (
    typeof metric === 'object' &&
    metric !== null &&
    'kind' in metric &&
    metric.kind === 'checkpoint'
  )
}

/** An export owns the session: its abort handle is live or it is exporting. */
export function hasActiveExport(
  exportAbortController: AbortController | null,
  session: ImageSession | null,
): boolean {
  return (
    Boolean(exportAbortController && !exportAbortController.signal.aborted) ||
    session?.exportState.status === 'exporting'
  )
}

export function clearExportResultState<T extends ImageSession | null>(
  session: T,
): T {
  if (
    !session?.exportState.result &&
    session?.exportState.status !== 'ready' &&
    session?.exportState.status !== 'exporting'
  ) {
    return session
  }

  return {
    ...session,
    exportState: {
      ...session.exportState,
      status:
        session.exportState.status === 'ready' ||
        session.exportState.status === 'exporting'
          ? 'idle'
          : session.exportState.status,
      result: undefined,
      lastProgress:
        session.exportState.status === 'exporting'
          ? undefined
          : session.exportState.lastProgress,
    },
  }
}

export function clearExportResultForActiveExport(
  session: ImageSession,
): ImageSession {
  return {
    ...session,
    exportState: {
      ...session.exportState,
      result: undefined,
      lastProgress: undefined,
      retryRecommended: false,
      recommendedRetryLevel: undefined,
    },
  }
}

export function hasSameRawRenderExposure(
  current: RawRenderExposure | null | undefined,
  next: RawRenderExposure | null | undefined,
) {
  if (!current || !next) {
    return current === next
  }

  return (
    current.ev === next.ev &&
    current.multiplier === next.multiplier &&
    current.source === next.source
  )
}

export function changesRenderGraphParams(
  current: ProcessingParams,
  next: Partial<ProcessingParams>,
) {
  return (
    (Object.hasOwn(next, 'styleKind') &&
      next.styleKind !== current.styleKind) ||
    (Object.hasOwn(next, 'builtinPreset') &&
      next.builtinPreset !== current.builtinPreset) ||
    (Object.hasOwn(next, 'intensity') &&
      next.intensity !== current.intensity) ||
    (Object.hasOwn(next, 'userExposureEv') &&
      next.userExposureEv !== current.userExposureEv) ||
    (Object.hasOwn(next, 'userContrast') &&
      next.userContrast !== current.userContrast) ||
    (Object.hasOwn(next, 'userHighlights') &&
      next.userHighlights !== current.userHighlights) ||
    (Object.hasOwn(next, 'userShadows') &&
      next.userShadows !== current.userShadows) ||
    (Object.hasOwn(next, 'userWhites') &&
      next.userWhites !== current.userWhites) ||
    (Object.hasOwn(next, 'userBlacks') &&
      next.userBlacks !== current.userBlacks) ||
    (Object.hasOwn(next, 'userTemperature') &&
      next.userTemperature !== current.userTemperature) ||
    (Object.hasOwn(next, 'userTint') && next.userTint !== current.userTint) ||
    (Object.hasOwn(next, 'userSaturation') &&
      next.userSaturation !== current.userSaturation) ||
    (Object.hasOwn(next, 'userVibrance') &&
      next.userVibrance !== current.userVibrance) ||
    (Object.hasOwn(next, 'selectiveColor') &&
      changesSelectiveColor(current.selectiveColor, next.selectiveColor))
  )
}

function changesSelectiveColor(
  current: ProcessingParams['selectiveColor'],
  next: ProcessingParams['selectiveColor'],
) {
  // Normalize both sides through the runtime so undefined/partial records and
  // an explicit all-neutral record compare equal. The export color graph and
  // the LUT bake see the normalized record, so this matches the contract that
  // actually feeds the renderer.
  const currentBands = normalizeSelectiveColorParams({
    selectiveColor: current,
  })
  const nextBands = normalizeSelectiveColorParams({ selectiveColor: next })
  for (const id of [
    'red',
    'orange',
    'yellow',
    'green',
    'aqua',
    'blue',
    'purple',
    'magenta',
  ] as const) {
    const cur = currentBands[id]
    const nxt = nextBands[id]
    if (
      cur.hue !== nxt.hue ||
      cur.saturation !== nxt.saturation ||
      cur.lightness !== nxt.lightness
    ) {
      return true
    }
  }
  return false
}
