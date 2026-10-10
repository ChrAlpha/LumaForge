import type { LumaRawSupportLevel } from '@lumaforge/luma-raw-runtime'

import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
  SupportLevel,
  TransformIntent,
  TransformState,
} from './session'

export type RetainedSessionState = {
  activeStyle?: StyleAsset | null
  lutProfileSelection?: LUTContractSelectionState
}

/**
 * Reads a runtime support level at the app boundary. The published runtime
 * union still carries 'official', which the app states as experimental;
 * 'unsupported' stays exact.
 */
export function toAppSupportLevel(level: LumaRawSupportLevel): SupportLevel {
  return level === 'unsupported' ? 'unsupported' : 'experimental'
}

/** The Transform that leaves the photo as it is, as a fresh value. */
export function createNeutralTransformIntent(): TransformIntent {
  return {
    upright: 'off',
    manual: { ...NEUTRAL_TRANSFORM },
    constrainCrop: true,
  }
}

/**
 * A source's Transform before anything was asked of it. Every source starts
 * neutral; no intent carries over from the one it replaces.
 */
export function createTransformState(sourceId: string): TransformState {
  return {
    sourceId,
    intent: createNeutralTransformIntent(),
    capture: null,
    issuedRequests: 0,
    request: null,
    accepted: null,
  }
}

export function createImageSession(
  file: File,
  retained?: RetainedSessionState,
): ImageSession {
  const id = globalThis.crypto.randomUUID()
  return {
    id,
    createdAt: Date.now(),
    sourceFile: {
      file,
      name: file.name,
      extension: file.name.split('.').pop()?.toLowerCase() || '',
      sizeBytes: file.size,
      supportLevel: 'experimental',
    },
    previewBundle: {
      embeddedPreview: { status: 'idle' },
      quickDecodePreview: { status: 'idle' },
      boundedHqPreview: { status: 'idle' },
      displaySource: 'none',
      boundedHqRequiredForExport: false,
    },
    activeStyle: retained?.activeStyle ?? null,
    exportGeometry: null,
    transform: createTransformState(id),
    lutProfileSelection: retained?.lutProfileSelection,
    viewState: {
      mode: DEFAULT_PREVIEW_VIEW.mode,
      compareSplit: DEFAULT_PREVIEW_VIEW.compareSplit,
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    renderState: { status: 'idle' },
    exportState: {
      status: 'idle',
      fullResCapability: { status: 'unknown' },
      retryRecommended: false,
    },
  }
}
