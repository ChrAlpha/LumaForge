import { memo } from 'react'

import type { PreviewHistogramSource } from '../hooks/usePublishedPreviewHistogram'
import { usePublishedPreviewHistogram } from '../hooks/usePublishedPreviewHistogram'

/**
 * Hosts the preview histogram beside the stage. It draws nothing; its own
 * renders (one per histogram result) stop here instead of rerendering the
 * workspace, and it rerenders from above only when its inputs change.
 */
export const PreviewHistogramRunner = memo((props: PreviewHistogramSource) => {
  usePublishedPreviewHistogram(props)
  return null
})
