import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { useCallback } from 'react'

import {
  useDetachedPreviewViewValue,
  useSetDetachedPreviewView,
} from '../state/preview-view.atoms'
import {
  useLutValue,
  useProcessingParamsValue,
  useSetLut,
  useSetProcessingParams,
} from '../state/workflow.atoms'
import type { SetColorIntent } from './stages/look/useRawAdjustmentActions'

/**
 * The state that exists before and between sessions: the color intent, the
 * detached sample view and the loaded LUT.
 *
 * `setColorIntent` is the only write into the stored intent. It keeps the
 * intent strict: whatever a caller hands it is copied down to the color
 * fields, so view state can never land there. An updater that returns its
 * input leaves the stored intent untouched.
 */
export function useRawDetachedWorkflowState() {
  const colorIntent = useProcessingParamsValue()
  const setStoredColorIntent = useSetProcessingParams()
  const detachedView = useDetachedPreviewViewValue()
  const setDetachedView = useSetDetachedPreviewView()
  const lut = useLutValue()
  const setLut = useSetLut()

  const setColorIntent = useCallback<SetColorIntent>(
    (value) => {
      setStoredColorIntent((prev) => {
        const next = typeof value === 'function' ? value(prev) : value
        return next === prev ? prev : pickColorGraphIntent(next)
      })
    },
    [setStoredColorIntent],
  )

  return {
    colorIntent,
    setColorIntent,
    detachedView,
    setDetachedView,
    lut,
    setLut,
  }
}
