import type { ProcessingParams } from '@lumaforge/luma-color-runtime'
import { pickColorGraphIntent } from '@lumaforge/luma-color-runtime'
import { useCallback } from 'react'

import {
  getDetachedPreviewView,
  useDetachedPreviewViewValue,
  useSetDetachedPreviewView,
} from '../state/preview-view.atoms'
import {
  useLutValue,
  useProcessingParamsValue,
  useSetLut,
  useSetProcessingParams,
} from '../state/workflow.atoms'
import { composeProcessingParams } from './stages/compare/useRawCompareStage'

type SetDetachedProcessingParams = (
  value: ProcessingParams | ((prev: ProcessingParams) => ProcessingParams),
) => void

/**
 * The state that exists before and between sessions: the color intent, the
 * detached sample view and the loaded LUT.
 *
 * `setParams` takes the combined record the look and ingest stages still
 * write. It stores only the color intent: an updater sees the intent with the
 * detached view laid over it, and any view fields it returns are dropped,
 * because view writes go through the compare stage to whichever owner exists.
 * An updater that returns its input leaves the stored intent untouched.
 */
export function useRawDetachedWorkflowState() {
  const colorIntent = useProcessingParamsValue()
  const setColorIntent = useSetProcessingParams()
  const detachedView = useDetachedPreviewViewValue()
  const setDetachedView = useSetDetachedPreviewView()
  const lut = useLutValue()
  const setLut = useSetLut()

  const setParams = useCallback<SetDetachedProcessingParams>(
    (value) => {
      setColorIntent((prev) => {
        if (typeof value !== 'function') {
          return pickColorGraphIntent(value)
        }
        const combined = composeProcessingParams(prev, getDetachedPreviewView())
        const next = value(combined)
        return next === combined ? prev : pickColorGraphIntent(next)
      })
    },
    [setColorIntent],
  )

  return {
    colorIntent,
    setParams,
    detachedView,
    setDetachedView,
    lut,
    setLut,
  }
}
