import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { TrackedPointer } from '../../components/preview-canvas-helpers'
import {
  getPointerDistance,
  getPointerMidpoint,
  tryCapturePointer,
  tryReleasePointer,
} from '../../components/preview-canvas-helpers'
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
    onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => void
  }
}

/**
 * Wheel zoom, one-pointer pan, two-pointer pinch, and double-click reset for
 * the preview frame. Moves are batched into one viewport commit per animation
 * frame; lifting the last pointer commits at once. It owns only zoom and pan:
 * the compare split and the processed color are not its concern.
 */
export function usePreviewViewportGestures({
  frameRef,
  trackRef,
  viewport,
  enabled,
  onViewportChange,
}: PreviewViewportGestureOptions): PreviewViewportGestures {
  const viewportRef = useRef(viewport)
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

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

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

  const commitViewport = useCallback(
    (next: PreviewViewport) => {
      viewportRef.current = next
      onViewportChange?.(next)
    },
    [onViewportChange],
  )

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
          onViewportChange?.(pending)
        }
      })
    },
    [onViewportChange],
  )

  const flushViewportCommit = useCallback(() => {
    if (pendingViewportRafRef.current !== null) {
      cancelAnimationFrame(pendingViewportRafRef.current)
      pendingViewportRafRef.current = null
    }
    const pending = pendingViewportRef.current
    if (pending) {
      pendingViewportRef.current = null
      onViewportChange?.(pending)
    }
  }, [onViewportChange])

  const resetActivePointers = useCallback(() => {
    activePointersRef.current.clear()
    pinchStartRef.current = null
    setIsPointerPanning(false)
  }, [])

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
    const activePointers = activePointersRef.current
    return () => {
      if (pendingViewportRafRef.current !== null) {
        cancelAnimationFrame(pendingViewportRafRef.current)
        pendingViewportRafRef.current = null
      }
      pendingViewportRef.current = null
      if (wheelInteractionTimeoutRef.current !== null) {
        window.clearTimeout(wheelInteractionTimeoutRef.current)
        wheelInteractionTimeoutRef.current = null
      }
      const captureTarget = captureTargetRef.current
      if (captureTarget) {
        for (const pointerId of activePointers.keys()) {
          tryReleasePointer(captureTarget, pointerId)
        }
      }
      captureTargetRef.current = null
      activePointers.clear()
      pinchStartRef.current = null
    }
  }, [])

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

  // Release and cancel end a pointer even while interaction is disabled, so
  // a gesture that started before never stays captured.
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
        flushViewportCommit()
        setIsPointerPanning(false)
      }
    },
    [flushViewportCommit],
  )

  const handleDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!enabled) return

      event.preventDefault()
      event.stopPropagation()
      resetActivePointers()
      commitViewport(resetPreviewViewport())
    },
    [enabled, commitViewport, resetActivePointers],
  )

  return {
    isPointerPanning,
    isWheelInteracting,
    frameHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerRelease,
      onPointerCancel: handlePointerRelease,
      onDoubleClick: handleDoubleClick,
    },
  }
}
