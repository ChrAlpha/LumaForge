import type { LumaRawSupportLevel } from '@lumaforge/luma-raw-runtime'

import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import type {
  ImageSession,
  LUTContractSelectionState,
  StyleAsset,
  SupportLevel,
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

export function createImageSession(
  file: File,
  retained?: RetainedSessionState,
): ImageSession {
  return {
    id: globalThis.crypto.randomUUID(),
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
      recovery: { status: 'none' },
      checkpointDurable: false,
      retryRecommended: false,
    },
  }
}
