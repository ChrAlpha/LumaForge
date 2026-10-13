import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'

import { setDetachedPreviewView } from '../state/preview-view.atoms'
import {
  DEFAULT_COLOR_INTENT,
  setErrorMessage,
  setLut,
  setPipelineStats,
  setProcessingParams,
  setProcessingStatus,
  setProgress,
} from '../state/workflow.atoms'

/** Puts every workflow atom of the shared store back to its initial value. */
export function resetToDefaults(): void {
  setProcessingStatus('idle')
  setErrorMessage(null)
  setProgress(0)
  setPipelineStats(null)
  setLut(null)
  setProcessingParams({ ...DEFAULT_COLOR_INTENT })
  setDetachedPreviewView(DEFAULT_PREVIEW_VIEW)
}
