import type { PreviewViewMode } from '~/lib/preview/preview-view'

import type { ImageSession } from '../../model/session'
import type { PreviewViewport } from '../preview/preview-viewport'
import { normalizePreviewViewport } from '../preview/preview-viewport'
import { clampCompareSplit } from './compare-split'

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
