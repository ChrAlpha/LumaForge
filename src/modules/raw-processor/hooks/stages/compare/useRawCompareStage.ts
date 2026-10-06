import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'

import type { PreviewView, PreviewViewMode } from '~/lib/preview/preview-view'

import type { ImageSession } from '../../../model/session'
import {
  computeCompareSplitChange,
  computeViewModeChange,
  computeViewportChange,
} from '../../../services/look/orchestrate-params-update'
import type { PreviewViewport } from '../../../services/preview/preview-viewport'
import {
  DEFAULT_PREVIEW_VIEWPORT,
  normalizePreviewViewport,
} from '../../../services/preview/preview-viewport'

type UseRawCompareStageInput = {
  /** The sample's view while no session exists. */
  detachedView: PreviewView
  setDetachedView: Dispatch<SetStateAction<PreviewView>>
  session: ImageSession | null
  sessionRef: MutableRefObject<ImageSession | null>
  setSession: Dispatch<SetStateAction<ImageSession | null>>
}

export function useRawCompareStage({
  detachedView,
  setDetachedView,
  session,
  sessionRef,
  setSession,
}: UseRawCompareStageInput) {
  const sessionViewMode = session?.viewState.mode
  const sessionCompareSplit = session?.viewState.compareSplit
  const sessionZoom = session?.viewState.zoom
  const sessionPanX = session?.viewState.panX
  const sessionPanY = session?.viewState.panY
  const sessionFitMode = session?.viewState.fitMode

  // A session owns the view once it exists; before that the detached sample
  // view does. Only one of them is read at a time, and the view never meets
  // the color intent: each is published on its own.
  const view = useMemo<PreviewView>(() => {
    if (!sessionViewMode || sessionCompareSplit === undefined) {
      return detachedView
    }

    return { mode: sessionViewMode, compareSplit: sessionCompareSplit }
  }, [detachedView, sessionCompareSplit, sessionViewMode])

  const previewViewport = useMemo(
    () =>
      sessionZoom === undefined ||
      sessionPanX === undefined ||
      sessionPanY === undefined ||
      !sessionFitMode
        ? DEFAULT_PREVIEW_VIEWPORT
        : normalizePreviewViewport({
            zoom: sessionZoom,
            panX: sessionPanX,
            panY: sessionPanY,
            fitMode: sessionFitMode,
          }),
    [sessionFitMode, sessionPanX, sessionPanY, sessionZoom],
  )

  // Writes route through the session ref, which load and reset update
  // synchronously, so a write in the same tick as a load or reset reaches the
  // owner that exists after it rather than the one this render saw.
  const setViewMode = useCallback(
    (mode: PreviewViewMode) => {
      if (sessionRef.current) {
        setSession((prev) => computeViewModeChange(prev, mode))
        return
      }

      setDetachedView((prev) => (prev.mode === mode ? prev : { ...prev, mode }))
    },
    [sessionRef, setDetachedView, setSession],
  )

  const setCompareSplit = useCallback(
    (split: number) => {
      const { nextSplit } = computeCompareSplitChange(null, split)

      if (sessionRef.current) {
        setSession((prev) => computeCompareSplitChange(prev, nextSplit).session)
        return
      }

      setDetachedView((prev) =>
        prev.compareSplit === nextSplit
          ? prev
          : { ...prev, compareSplit: nextSplit },
      )
    },
    [sessionRef, setDetachedView, setSession],
  )

  const setPreviewViewport = useCallback(
    (viewport: PreviewViewport) => {
      setSession((prev) => computeViewportChange(prev, viewport))
    },
    [setSession],
  )

  const resetPreviewViewport = useCallback(() => {
    setPreviewViewport(DEFAULT_PREVIEW_VIEWPORT)
  }, [setPreviewViewport])

  return {
    view,
    viewMode: view.mode,
    compareSplit: view.compareSplit,
    previewViewport,
    setViewMode,
    setCompareSplit,
    setPreviewViewport,
    resetPreviewViewport,
  }
}
