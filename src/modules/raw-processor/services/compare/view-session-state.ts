import type { PreviewBackendState } from '~/lib/preview/gpu-backend'
import type { PreviewViewMode } from '~/lib/preview/preview-view'
import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import type { ImageSession } from '../../model/session'
import type { PreviewViewport } from '../preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  normalizePreviewViewport,
} from '../preview/preview-viewport'
import { deriveToolAvailability } from '../surface/derive-tool-availability'
import { clampCompareSplit } from './compare-split'

/**
 * The session view commands a surface can refuse. Leaving for the processed
 * photo is not one of them: it is always open.
 */
export type SessionViewCommand = 'originalView' | 'split' | 'splitReset'

export interface SessionViewCommandFacts {
  session: ImageSession
  /** The decoded preview is still held, so export has not released it. */
  hasDecodedImage: boolean
  backend: PreviewBackendState
}

/**
 * Export holds the preview released while its plan runs, and after it while
 * the delivered JPEG stands in for a decoded preview that is gone.
 */
export function isSessionPreviewReleased(
  session: ImageSession,
  hasDecodedImage: boolean,
): boolean {
  const { exportState } = session
  if (!exportState.activePlan) return false
  if (exportState.status === 'exporting') return true
  return (
    exportState.status === 'ready' &&
    Boolean(exportState.result) &&
    !hasDecodedImage &&
    !session.previewBundle.embeddedPreview.objectUrl
  )
}

/**
 * Whether a session view command may run, through the same action policy
 * the tool surfaces draw from. The CPU preview shows the original but has no
 * split; a committed Transform or a released preview refuses both. Busy-stage
 * locks stay with each surface: the command holds only the floor every
 * surface shares, and a session owns its view whether or not it has drawn.
 */
export function canRunSessionViewCommand(
  command: SessionViewCommand,
  { session, hasDecodedImage, backend }: SessionViewCommandFacts,
): boolean {
  const availability = deriveToolAvailability({
    surface: 'desktop',
    hasImage: true,
    status: 'ready',
    // Only a backend that resolved to WebGPU draws a split; until it
    // resolves, nothing proves there is one.
    executor: backend.status === 'ready' ? backend.facts.backend : 'cpu',
    previewSuspended: isSessionPreviewReleased(session, hasDecodedImage),
    transformActive: Boolean(session.exportGeometry),
    transformExportBlock: null,
    hasAppliedLut: false,
    canExport: false,
    lutContractBlocksExport: false,
    canPreviewExport: false,
    hasExportResult: false,
  })

  return availability[command].available
}

/**
 * The command a view mode asks for, or null when it only leaves for the
 * processed photo.
 */
export function sessionViewCommandForMode(
  mode: PreviewViewMode,
): SessionViewCommand | null {
  switch (mode) {
    case 'original': {
      return 'originalView'
    }
    case 'compare': {
      return 'split'
    }
    default: {
      return null
    }
  }
}

/** The side by side at its centre with the photo back at fit, in one write. */
export function applyCompareViewResetToSession(
  session: ImageSession,
): ImageSession {
  return {
    ...session,
    viewState: {
      ...session.viewState,
      ...DEFAULT_PREVIEW_VIEWPORT,
      mode: 'compare',
      compareSplit: DEFAULT_PREVIEW_VIEW.compareSplit,
    },
  }
}

export function applyViewModeToSession(
  session: ImageSession,
  mode: PreviewViewMode,
): ImageSession {
  return {
    ...session,
    viewState: {
      ...session.viewState,
      mode,
    },
  }
}

export function applyCompareSplitToSession(
  session: ImageSession,
  split: number,
): ImageSession {
  return {
    ...session,
    viewState: {
      ...session.viewState,
      compareSplit: clampCompareSplit(split),
    },
  }
}

export function applyPreviewViewportToSession(
  session: ImageSession,
  viewport: PreviewViewport,
): ImageSession {
  return {
    ...session,
    viewState: {
      ...session.viewState,
      ...normalizePreviewViewport(viewport),
    },
  }
}
