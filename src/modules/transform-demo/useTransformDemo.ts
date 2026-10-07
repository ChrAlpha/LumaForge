import type { SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { UprightMode } from '~/lib/transform/geometry/types'
import type {
  ImageInputErrorCode,
  PreviewSource,
} from '~/lib/transform/preview-types'
import { ImageInputError } from '~/lib/transform/preview-types'
import type { ManualTransform } from '~/lib/transform/transform-types'
import { useTransformPreview } from '~/modules/raw-processor/hooks/useTransformPreview'
import type { TransformIntent } from '~/modules/raw-processor/model/session'
import { createNeutralTransformIntent } from '~/modules/raw-processor/model/session-factory'

import { createDemoSample } from './demo-sample'
import { loadImageInput } from './image-input'

/**
 * The demo's file and sample loading around the production Transform
 * preview. It decodes what the user opens and hands the frame over; the
 * analysis, rendering and acknowledgement all belong to `useTransformPreview`.
 * With no RAW session behind it, the demo holds the intent itself, and every
 * photo it opens starts neutral.
 */
export function useTransformDemo({ autoLoadSample = true } = {}) {
  const [intent, setIntent] = useState<TransformIntent>(
    createNeutralTransformIntent,
  )
  const preview = useTransformPreview(intent)
  const {
    loadSource: loadPreviewFrame,
    clearSource: clearPreviewFrame,
    solveUpright,
    retireFailure,
  } = preview
  const loadFrame = useCallback(
    (next: PreviewSource) => {
      setIntent(createNeutralTransformIntent())
      loadPreviewFrame(next)
    },
    [loadPreviewFrame],
  )
  const clearFrame = useCallback(() => {
    setIntent(createNeutralTransformIntent())
    clearPreviewFrame()
  }, [clearPreviewFrame])
  const [decoding, setDecoding] = useState(false)
  const [inputError, setInputError] = useState<ImageInputErrorCode | null>(null)
  const loadId = useRef(0)
  const abortRef = useRef<AbortController | null>(null)

  /** Retire any decode still running, so only the newest input can land. */
  const supersede = useCallback(() => {
    const id = ++loadId.current
    abortRef.current?.abort()
    abortRef.current = null
    setDecoding(false)
    setInputError(null)
    return id
  }, [])

  /** Open a file, or the synthetic sample when there is none. */
  const loadSource = useCallback(
    async (file?: File) => {
      const id = supersede()
      if (!file) {
        loadFrame(createDemoSample())
        return
      }
      const abort = new AbortController()
      abortRef.current = abort
      // The previous photo and its edits must not read as current while the
      // replacement decodes.
      clearFrame()
      setDecoding(true)
      try {
        const next = await loadImageInput(file, abort.signal)
        if (id !== loadId.current || abort.signal.aborted) return
        setDecoding(false)
        loadFrame(next)
      } catch (cause) {
        if (id !== loadId.current || abort.signal.aborted) return
        setDecoding(false)
        setInputError(cause instanceof ImageInputError ? cause.code : 'decode')
      }
    },
    [clearFrame, loadFrame, supersede],
  )

  const clearSource = useCallback(() => {
    supersede()
    clearFrame()
  }, [clearFrame, supersede])

  const dispose = useCallback(() => {
    ++loadId.current
    abortRef.current?.abort()
  }, [])

  useEffect(() => {
    if (autoLoadSample) void loadSource()
    return dispose
  }, [autoLoadSample, dispose, loadSource])

  const setMode = (upright: UprightMode) => {
    setIntent((previous) => ({ ...previous, upright }))
    solveUpright()
  }
  const setManual = (manual: SetStateAction<ManualTransform>) =>
    setIntent((previous) => ({
      ...previous,
      manual: typeof manual === 'function' ? manual(previous.manual) : manual,
    }))
  const setConstrainCrop = (constrainCrop: boolean) =>
    setIntent((previous) => ({ ...previous, constrainCrop }))

  const reset = () => {
    setInputError(null)
    setIntent(createNeutralTransformIntent())
    retireFailure()
  }

  return {
    ...preview,
    mode: intent.upright,
    setMode,
    manual: intent.manual,
    setManual,
    constrainCrop: intent.constrainCrop,
    setConstrainCrop,
    loading: decoding || preview.loading,
    error: inputError ?? preview.error,
    loadSource,
    clearSource,
    reset,
  }
}
