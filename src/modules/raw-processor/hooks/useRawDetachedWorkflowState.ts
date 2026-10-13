import {
  useDetachedPreviewViewValue,
  useSetDetachedPreviewView,
} from '../state/preview-view.atoms'
import {
  setColorIntent,
  useLutValue,
  useProcessingParamsValue,
  useSetLut,
} from '../state/workflow.atoms'

/**
 * The state that exists before and between sessions: the color intent, the
 * detached sample view and the loaded LUT.
 */
export function useRawDetachedWorkflowState() {
  const colorIntent = useProcessingParamsValue()
  const detachedView = useDetachedPreviewViewValue()
  const setDetachedView = useSetDetachedPreviewView()
  const lut = useLutValue()
  const setLut = useSetLut()

  return {
    colorIntent,
    setColorIntent,
    detachedView,
    setDetachedView,
    lut,
    setLut,
  }
}
