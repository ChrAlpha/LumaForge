import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TrackedPointer } from '../../services/preview/preview-canvas-helpers'
import {
  getPointerDistance,
  getPointerMidpoint,
  tryCapturePointer,
  tryReleasePointer,
} from '../../services/preview/preview-canvas-helpers'
import type {
  PreviewViewport,
  PreviewViewportGeometry,
} from '../../services/preview/preview-viewport'
import {
  getWheelPreviewZoomTarget,
  panPreviewViewport,
  resetPreviewViewport,
  zoomPreviewViewportAtPoint,
} from '../../services/preview/preview-viewport'

/** How long the wheel transform stays active after the last wheel event. */
const WHEEL_INTERACTION_IDLE_MS = 180

/** How many delivered commits may wait for the parent to render them back. */
const MAX_UNECHOED_COMMITS = 8

function sameViewport(a: PreviewViewport, b: PreviewViewport) {
  return (
    a.zoom === b.zoom &&
    a.panX === b.panX &&
    a.panY === b.panY &&
    a.fitMode === b.fitMode
  )
}

export interface PreviewViewportGestureOptions {
  /** The interactive frame: gestures are measured against its center. */
  frameRef: RefObject<HTMLDivElement | null>
  /** The aspect-fit photo track: its layout size bounds the pan. */
  trackRef: RefObject<HTMLDivElement | null>
  /** The committed, normalized viewport the frame shows. */
  viewport: PreviewViewport
  enabled: boolean
  onViewportChange?: (viewport: PreviewViewport) => void
}

export interface PreviewViewportGestures {
  isPointerPanning: boolean
  isWheelInteracting: boolean
  frameHandlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => void
    onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  }
}

/**
 * Wheel zoom, one-pointer pan, two-pointer pinch, and double-click reset for
 * the preview frame. Moves are batched into one viewport commit per animation
 * frame; lifting, cancelling, or losing the capture of the last pointer
 * commits at once. Gestures accumulate on the hook's own viewport: a render
 * that hands back an equal viewport, or one this hook committed, leaves it
 * alone, and only a different viewport from outside supersedes it, dropping
 * the commit still waiting and rebasing a held pinch. Disabling ends the
 * gesture, drops what it has not committed, and returns to the viewport last
 * delivered. It owns only zoom and pan: the compare split and the processed
 * color are not its concern.
 */
export function usePreviewViewportGestures({
  frameRef,
  trackRef,
  viewport,
  enabled,
  onViewportChange,
}: PreviewViewportGestureOptions): PreviewViewportGestures {
  const viewportRef = useRef(viewport)
  const viewportPropRef = useRef(viewport)
  /** The newest viewport the parent holds: delivered to it, or given from it. */
  const deliveredViewportRef = useRef(viewport)
  const unechoedCommitsRef = useRef<PreviewViewport[]>([])
  const activePointersRef = useRef(new Map<number, TrackedPointer>())
  const captureTargetRef = useRef<HTMLElement | null>(null)
  const pinchStartRef = useRef<{
    distance: number
    midpoint: TrackedPointer
    viewport: PreviewViewport
  } | null>(null)
  const pendingViewportRef = useRef<PreviewViewport | null>(null)
  const pendingViewportRafRef = useRef<number | null>(null)
  const wheelInteractionTimeoutRef = useRef<number | null>(null)
  const [isPointerPanning, setIsPointerPanning] = useState(false)
  const [isWheelInteracting, setIsWheelInteracting] = useState(false)

  const getViewportGeometry = useCallback(() => {
    const frame = frameRef.current
    const track = trackRef.current

    if (!frame || !track) return null

    const frameRect = frame.getBoundingClientRect()
    const trackRect = track.getBoundingClientRect()
    const contentWidth =
      track.offsetWidth || track.clientWidth || trackRect.width
    const contentHeight =
      track.offsetHeight || track.clientHeight || trackRect.height

    if (
      frameRect.width <= 0 ||
      frameRect.height <= 0 ||
      contentWidth <= 0 ||
      contentHeight <= 0
    ) {
      return null
    }

    return {
      frameRect,
      geometry: {
        viewportWidth: frameRect.width,
        viewportHeight: frameRect.height,
        contentWidth,
        contentHeight,
      } satisfies PreviewViewportGeometry,
    }
  }, [frameRef, trackRef])

  /** A client point as an offset from the frame center. */
  const getRelativeOrigin = useCallback(
    (clientX: number, clientY: number) => {
      const viewportGeometry = getViewportGeometry()
      if (!viewportGeometry) return null

      const { frameRect, geometry } = viewportGeometry

      return {
        geometry,
        originX: clientX - frameRect.left - frameRect.width / 2,
        originY: clientY - frameRect.top - frameRect.height / 2,
      }
    },
    [getViewportGeometry],
  )

  /**
   * Delivers a viewport and remembers it until the parent renders it back;
   * one equal to the viewport already shown changes no prop to wait for.
   */
  const deliverViewport = useCallback(
    (next: PreviewViewport) => {
      if (!sameViewport(next, viewportPropRef.current)) {
        const unechoed = unechoedCommitsRef.current
        unechoed.push(next)
        if (unechoed.length > MAX_UNECHOED_COMMITS) unechoed.shift()
      }
      deliveredViewportRef.current = next
      onViewportChange?.(next)
    },
    [onViewportChange],
  )

  const dropPendingCommit = useCallback(() => {
    if (pendingViewportRafRef.current !== null) {
      cancelAnimationFrame(pendingViewportRafRef.current)
      pendingViewportRafRef.current = null
    }
    pendingViewportRef.current = null
  }, [])

  const scheduleViewportCommit = useCallback(
    (next: PreviewViewport) => {
      viewportRef.current = next
      pendingViewportRef.current = next

      if (pendingViewportRafRef.current !== null) return

      pendingViewportRafRef.current = requestAnimationFrame(() => {
        pendingViewportRafRef.current = null
        const pending = pendingViewportRef.current
        if (pending) {
          pendingViewportRef.current = null
          deliverViewport(pending)
        }
      })
    },
    [deliverViewport],
  )

  const flushViewportCommit = useCallback(() => {
    const pending = pendingViewportRef.current
    dropPendingCommit()
    if (pending) deliverViewport(pending)
  }, [deliverViewport, dropPendingCommit])

  /** Releases every capture the gesture holds and forgets its pointers. */
  const releaseActivePointers = useCallback(() => {
    const captureTarget = captureTargetRef.current
    if (captureTarget) {
      for (const pointerId of activePointersRef.current.keys()) {
        tryReleasePointer(captureTarget, pointerId)
      }
    }
    captureTargetRef.current = null
    activePointersRef.current.clear()
    pinchStartRef.current = null
  }, [])

  // A viewport prop moves the gesture only when it is new from outside: an
  // equal one, or one this hook committed coming back, keeps the gesture's
  // own accumulation.
  useEffect(() => {
    if (sameViewport(viewport, viewportPropRef.current)) return
    viewportPropRef.current = viewport

    const unechoed = unechoedCommitsRef.current
    const echoIndex = unechoed.findIndex((committed) =>
      sameViewport(committed, viewport),
    )
    if (echoIndex >= 0) {
      unechoed.splice(0, echoIndex + 1)
      return
    }

    unechoed.length = 0
    dropPendingCommit()
    viewportRef.current = viewport
    deliveredViewportRef.current = viewport
    const pointers = Array.from(activePointersRef.current.values())
    if (pointers.length >= 2 && pinchStartRef.current) {
      const [first, second] = pointers
      pinchStartRef.current = {
        distance: getPointerDistance(first!, second!),
        midpoint: getPointerMidpoint(first!, second!),
        viewport,
      }
    }
  }, [viewport, dropPendingCommit])

  // What the gesture had not delivered is dropped with it, so the next
  // gesture builds on the viewport the parent holds, not on the dropped one.
  useEffect(() => {
    if (enabled) return
    dropPendingCommit()
    viewportRef.current = deliveredViewportRef.current
    if (activePointersRef.current.size === 0) return
    releaseActivePointers()
    setIsPointerPanning(false)
  }, [enabled, dropPendingCommit, releaseActivePointers])

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (!enabled) return

      const origin = getRelativeOrigin(event.clientX, event.clientY)
      if (!origin) return

      event.preventDefault()
      event.stopPropagation()
      setIsWheelInteracting(true)
      if (wheelInteractionTimeoutRef.current !== null) {
        window.clearTimeout(wheelInteractionTimeoutRef.current)
      }
      wheelInteractionTimeoutRef.current = window.setTimeout(() => {
        wheelInteractionTimeoutRef.current = null
        setIsWheelInteracting(false)
      }, WHEEL_INTERACTION_IDLE_MS)

      const current = viewportRef.current
      const nextZoom = getWheelPreviewZoomTarget(current.zoom, {
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
      })

      scheduleViewportCommit(
        zoomPreviewViewportAtPoint(current, {
          ...origin,
          nextZoom,
        }),
      )
    },
    [enabled, scheduleViewportCommit, getRelativeOrigin],
  )

  // React attaches wheel listeners as passive, so the frame listens directly
  // to keep the page from scrolling while the photo zooms.
  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return

    frame.addEventListener('wheel', handleWheel, { passive: false })

    return () => {
      frame.removeEventListener('wheel', handleWheel)
    }
  }, [frameRef, handleWheel])

  // Teardown drops a pending commit rather than delivering a viewport after
  // the frame is gone, and releases whatever the gesture still holds.
  useEffect(() => {
    return () => {
      dropPendingCommit()
      if (wheelInteractionTimeoutRef.current !== null) {
        window.clearTimeout(wheelInteractionTimeoutRef.current)
        wheelInteractionTimeoutRef.current = null
      }
      releaseActivePointers()
    }
  }, [dropPendingCommit, releaseActivePointers])

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled || event.button !== 0) return

      event.preventDefault()
      event.stopPropagation()
      captureTargetRef.current = event.currentTarget
      tryCapturePointer(event.currentTarget, event.pointerId)

      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      })

      const pointers = Array.from(activePointersRef.current.values())
      if (pointers.length >= 2) {
        const [first, second] = pointers
        pinchStartRef.current = {
          distance: getPointerDistance(first!, second!),
          midpoint: getPointerMidpoint(first!, second!),
          viewport: viewportRef.current,
        }
      }

      setIsPointerPanning(true)
    },
    [enabled],
  )

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return

      const previous = activePointersRef.current.get(event.pointerId)
      if (!previous) return

      event.preventDefault()
      event.stopPropagation()

      activePointersRef.current.set(event.pointerId, {
        clientX: event.clientX,
        clientY: event.clientY,
      })

      const pointers = Array.from(activePointersRef.current.values())
      const viewportGeometry = getViewportGeometry()
      if (!viewportGeometry) return

      if (pointers.length >= 2 && pinchStartRef.current) {
        const [first, second] = pointers
        const distance = getPointerDistance(first!, second!)
        if (pinchStartRef.current.distance <= 0) return

        // The pinch zooms around where it started, not where it drifts.
        const midpoint = pinchStartRef.current.midpoint
        const origin = getRelativeOrigin(midpoint.clientX, midpoint.clientY)
        if (!origin) return

        scheduleViewportCommit(
          zoomPreviewViewportAtPoint(pinchStartRef.current.viewport, {
            ...origin,
            nextZoom:
              pinchStartRef.current.viewport.zoom *
              (distance / pinchStartRef.current.distance),
          }),
        )
        return
      }

      if (viewportRef.current.zoom <= 1) {
        return
      }

      scheduleViewportCommit(
        panPreviewViewport(viewportRef.current, {
          geometry: viewportGeometry.geometry,
          deltaX: event.clientX - previous.clientX,
          deltaY: event.clientY - previous.clientY,
        }),
      )
    },
    [enabled, scheduleViewportCommit, getRelativeOrigin, getViewportGeometry],
  )

  // Release, cancel, and a lost capture each end their pointer the same way,
  // even while interaction is disabled, so no pointer stays held or captured.
  const handlePointerRelease = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!activePointersRef.current.has(event.pointerId)) return

      event.preventDefault()
      event.stopPropagation()
      activePointersRef.current.delete(event.pointerId)
      tryReleasePointer(event.currentTarget, event.pointerId)

      if (activePointersRef.current.size < 2) {
        pinchStartRef.current = null
      }
      if (activePointersRef.current.size === 0) {
        captureTargetRef.current = null
        flushViewportCommit()
        setIsPointerPanning(false)
      }
    },
    [flushViewportCommit],
  )

  // The reset supersedes whatever the gesture has not committed yet.
  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!enabled) return

      event.preventDefault()
      event.stopPropagation()
      releaseActivePointers()
      setIsPointerPanning(false)
      dropPendingCommit()
      const reset = resetPreviewViewport()
      viewportRef.current = reset
      deliverViewport(reset)
    },
    [enabled, deliverViewport, dropPendingCommit, releaseActivePointers],
  )

  return {
    isPointerPanning,
    isWheelInteracting,
    frameHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerRelease,
      onPointerCancel: handlePointerRelease,
      onLostPointerCapture: handlePointerRelease,
      onDoubleClick: handleDoubleClick,
    },
  }
}
