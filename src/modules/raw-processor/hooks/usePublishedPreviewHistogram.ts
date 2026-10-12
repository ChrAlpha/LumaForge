import type { PreviewHistogramState } from '@lumaforge/luma-color-runtime'
import { useAtomValue, useSetAtom } from 'jotai'
import { useLayoutEffect } from 'react'

import { jotaiStore } from '~/lib/jotai'

import {
  NO_IMAGE_HISTOGRAM,
  previewHistogramEnabledAtom,
  previewHistogramStateAtom,
} from '../state/histogram.atoms'
import { usePreviewHistogram } from './usePreviewHistogram'
import type { UseRawWorkflowReturn } from './useRawWorkflow.types'

export type PreviewHistogramSource = Pick<
  UseRawWorkflowReturn,
  | 'decodedImageRef'
  | 'decodedFrame'
  | 'params'
  | 'lutDataRef'
  | 'lutDataVersion'
  | 'displaySource'
>

/** A rebuilt stale or computing state over the same bins says nothing new. */
function isSameHistogramState(
  current: PreviewHistogramState,
  next: PreviewHistogramState,
) {
  if (current === next) return true
  if (current.state === 'stale' && next.state === 'stale') {
    return current.previous === next.previous
  }
  if (current.state === 'computing' && next.state === 'computing') {
    return current.previous === next.previous
  }
  return false
}

/**
 * Runs the preview histogram over the workflow's decoded frame and look
 * while a surface shows it, and publishes each result to
 * `previewHistogramStateAtom`. Its runs and results stay out of the
 * workflow's own renders, so a result rerenders only what reads the atom.
 */
export function usePublishedPreviewHistogram(source: PreviewHistogramSource) {
  const enabled = useAtomValue(previewHistogramEnabledAtom)
  const histogram = usePreviewHistogram({
    enabled,
    imageRef: source.decodedImageRef,
    frame: source.decodedFrame,
    params: source.params,
    lutDataRef: source.lutDataRef,
    lutDataVersion: source.lutDataVersion,
    displaySource: source.displaySource,
  })
  const publish = useSetAtom(previewHistogramStateAtom, { store: jotaiStore })

  // Before paint, so a surface never draws bins the runner has moved past.
  useLayoutEffect(() => {
    publish((current) =>
      isSameHistogramState(current, histogram) ? current : histogram,
    )
  }, [histogram, publish])
  useLayoutEffect(() => () => publish(NO_IMAGE_HISTOGRAM), [publish])
}
