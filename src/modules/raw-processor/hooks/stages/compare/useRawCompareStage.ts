import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useMemo } from 'react'

import { getPreviewBackendState } from '~/lib/preview/gpu-backend'
import type { PreviewView, PreviewViewMode } from '~/lib/preview/preview-view'
import { DEFAULT_PREVIEW_VIEW } from '~/lib/preview/preview-view'
import type { DecodedImage } from '~/lib/raw/decoder'

import type { ImageSession } from '../../../model/session'
import type { SessionViewCommand } from '../../../services/compare/view-session-state'
import {
  applyCompareSplitToSession,
  applyCompareViewResetToSession,
  applyViewModeToSession,
  canRunSessionViewCommand,
  sessionViewCommandForMode,
} from '../../../services/compare/view-session-state'
import {
  computeCompareSplitChange,
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
  decodedImageRef: { readonly current: DecodedImage | null }
}

export function useRawCompareStage({
  detachedView,
  setDetachedView,
  session,
  sessionRef,
  setSession,
  decodedImageRef,
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
  // owner that exists after it rather than the one this render saw. The
  // guard reads that owner, its decoded preview and the preview backend when
  // the command runs, so a callback held from an earlier render cannot split
  // a CPU preview or compare a committed Transform. A refused command writes
  // nothing, and a write lands only on the source it was guarded for. The
  // result says whether a session owned the write, applied or refused.
  const writeSessionView = useCallback(
    (
      command: SessionViewCommand | null,
      update: (session: ImageSession) => ImageSession,
    ) => {
      const target = sessionRef.current
      if (!target) return false

      if (
        command &&
        !canRunSessionViewCommand(command, {
          session: target,
          hasDecodedImage: decodedImageRef.current !== null,
          backend: getPreviewBackendState(),
        })
      ) {
        return true
      }

      setSession((prev) => (prev?.id === target.id ? update(prev) : prev))
      return true
    },
    [decodedImageRef, sessionRef, setSession],
  )

  // Before a source the detached sample compare owns the view, so its
  // original, split and reset stay open whatever the backend.
  const setViewMode = useCallback(
    (mode: PreviewViewMode) => {
      if (
        writeSessionView(sessionViewCommandForMode(mode), (session) =>
          applyViewModeToSession(session, mode),
        )
      ) {
        return
      }

      setDetachedView((prev) => (prev.mode === mode ? prev : { ...prev, mode }))
    },
    [setDetachedView, writeSessionView],
  )

  const setCompareSplit = useCallback(
    (split: number) => {
      const { nextSplit } = computeCompareSplitChange(null, split)

      if (
        writeSessionView('split', (session) =>
          applyCompareSplitToSession(session, nextSplit),
        )
      ) {
        return
      }

      setDetachedView((prev) =>
        prev.compareSplit === nextSplit
          ? prev
          : { ...prev, compareSplit: nextSplit },
      )
    },
    [setDetachedView, writeSessionView],
  )

  // Mode, split and viewport move together or not at all: a refused reset
  // leaves the zoomed crop where it was too.
  const resetCompareView = useCallback(() => {
    if (writeSessionView('splitReset', applyCompareViewResetToSession)) return

    setDetachedView((prev) =>
      prev.mode === DEFAULT_PREVIEW_VIEW.mode &&
      prev.compareSplit === DEFAULT_PREVIEW_VIEW.compareSplit
        ? prev
        : DEFAULT_PREVIEW_VIEW,
    )
  }, [setDetachedView, writeSessionView])

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
    resetCompareView,
    setPreviewViewport,
    resetPreviewViewport,
  }
}
