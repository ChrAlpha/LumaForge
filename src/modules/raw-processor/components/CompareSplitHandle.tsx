import { memo, useCallback, useEffect, useLayoutEffect, useRef } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

import {
  clampCompareSplit,
  COMPARE_SPLIT_MAX as MAX_SPLIT,
  COMPARE_SPLIT_MIN as MIN_SPLIT,
  getCompareSplitFromClientX,
} from '../services/compare/compare-split'

export {
  clampCompareSplit,
  getCompareSplitFromClientX,
} from '../services/compare/compare-split'

const KEYBOARD_STEP = 0.01
// Double-tap to reset (touch / pen): two taps inside this window and radius.
// Mouse uses the native dblclick instead.
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_SLOP_PX = 24
const RESET_SPLIT = 0.5
const IMAGE_TRACK_SELECTOR = '[data-raw-compare-track="image"]'

function isUsableRect(rect: Pick<DOMRect, 'width'>) {
  return Number.isFinite(rect.width) && rect.width > 0
}

function parseCssNumber(value: string, fallback: number) {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function readPreviewTransform(element: HTMLElement | null) {
  if (!element) return { zoom: 1, panX: 0 }
  const style = getComputedStyle(element)
  const zoom = parseCssNumber(style.getPropertyValue('--raw-preview-zoom'), 1)
  const panX = parseCssNumber(style.getPropertyValue('--raw-preview-pan-x'), 0)
  return {
    zoom: Number.isFinite(zoom) && zoom > 0 ? zoom : 1,
    panX: Number.isFinite(panX) ? panX : 0,
  }
}

interface TrackGeometry {
  frameRect: { left: number; width: number; top: number; height: number }
  trackLeft: number
  trackWidth: number
  /** Photo box inside the frame, used to clip the split line to the image. */
  trackTop: number
  trackHeight: number
  zoom: number
  panX: number
}

function getCompareTrackGeometry(target: HTMLElement): TrackGeometry {
  return getFrameTrackGeometry(target.parentElement ?? target)
}

function getFrameTrackGeometry(frame: HTMLElement): TrackGeometry {
  const frameRect = frame.getBoundingClientRect()
  const imageTrack = frame.querySelector<HTMLElement>(IMAGE_TRACK_SELECTOR)
  const imageRect = imageTrack?.getBoundingClientRect()
  const { zoom, panX } = readPreviewTransform(imageTrack ?? null)

  if (imageTrack && imageRect && isUsableRect(imageRect)) {
    // The track element itself is not transformed; the surface inside it is.
    // Use the pre-transform layout width when the DOM exposes it, otherwise
    // fall back to the track's own bounding box.
    const offsetWidth = imageTrack.offsetWidth
    const trackWidth = offsetWidth > 0 ? offsetWidth : imageRect.width
    const offsetHeight = imageTrack.offsetHeight
    const trackHeight = offsetHeight > 0 ? offsetHeight : imageRect.height
    return {
      frameRect,
      trackLeft: imageRect.left,
      trackWidth,
      trackTop: imageRect.top - frameRect.top,
      trackHeight,
      zoom,
      panX,
    }
  }

  return {
    frameRect,
    trackLeft: frameRect.left,
    trackWidth: frameRect.width,
    trackTop: 0,
    trackHeight: frameRect.height,
    zoom,
    panX,
  }
}

/**
 * Texture-coord (clip percentage) that visually lands at the given screen X.
 *
 * The clipped layer lives inside `.raw-preview-surface` which is CSS
 * `translate(panX) scale(zoom)` around its centre.  A layer-local fraction T
 * maps to screen X via:
 *   X = trackLeft + (T - 0.5) * zoom * trackWidth + trackWidth/2 + panX
 * Inverting:
 *   T = 0.5 + (X - trackLeft - trackWidth/2 - panX) / (zoom * trackWidth)
 *
 * Returns values outside [0,1] when the handle is in letterbox whitespace;
 * CSS clip-path treats `inset > 100%` / `inset < 0` as fully-clipped /
 * no-clip, which gives the "fully one side" view squoosh-style.
 */
function clipFracFromScreenX(screenX: number, geometry: TrackGeometry): number {
  const { trackLeft, trackWidth, zoom, panX } = geometry
  if (!trackWidth || zoom <= 0) return 0.5
  return (
    0.5 + (screenX - trackLeft - trackWidth / 2 - panX) / (zoom * trackWidth)
  )
}

function getHandlePositionX(frameRect: Pick<DOMRect, 'width'>, split: number) {
  if (!Number.isFinite(frameRect.width) || frameRect.width <= 0) return 0
  return frameRect.width * clampCompareSplit(split)
}

export function getCompareSplitInteractionGeometry(
  target: HTMLElement,
  clientX: number,
) {
  const geometry = getCompareTrackGeometry(target)
  const split = getCompareSplitFromClientX(geometry.frameRect, clientX)
  const handleX = getHandlePositionX(geometry.frameRect, split)
  const screenX = geometry.frameRect.left + handleX
  const clipSplit = clipFracFromScreenX(screenX, geometry)
  return { split, clipSplit, handleX, geometry }
}

export function getCompareSplitPositionGeometry(
  target: HTMLElement,
  value: number,
) {
  const geometry = getCompareTrackGeometry(target)
  const split = clampCompareSplit(value)
  const handleX = getHandlePositionX(geometry.frameRect, split)
  const screenX = geometry.frameRect.left + handleX
  const clipSplit = clipFracFromScreenX(screenX, geometry)
  return { split, clipSplit, handleX, geometry }
}

function applyHandlePosition(target: HTMLElement, value: number) {
  const { clipSplit, handleX, geometry } = getCompareSplitPositionGeometry(
    target,
    value,
  )
  applyCompareSplitVariables(target, clipSplit, handleX, geometry)
}

// Paints a split on the frame alone, for when the handle is already gone.
function applyFramePosition(frame: HTMLElement, value: number) {
  const geometry = getFrameTrackGeometry(frame)
  const handleX = getHandlePositionX(geometry.frameRect, value)
  const clipSplit = clipFracFromScreenX(
    geometry.frameRect.left + handleX,
    geometry,
  )
  applyFrameSplitVariables(frame, clipSplit, handleX, geometry)
}

function applyPointerPosition(target: HTMLElement, clientX: number) {
  const { split, clipSplit, handleX, geometry } =
    getCompareSplitInteractionGeometry(target, clientX)
  applyCompareSplitVariables(target, clipSplit, handleX, geometry)
  return split
}

function roundForCss(value: number) {
  return Number(value.toFixed(4))
}

function applyCompareSplitVariables(
  target: HTMLElement,
  clipSplit: number,
  handleX: number,
  geometry: TrackGeometry,
) {
  // The photo is letterboxed inside the frame. Publishing its vertical box
  // lets the split line stop at the photograph instead of running through
  // the empty mat above and below it.
  const top = Math.max(0, geometry.trackTop)
  const height = Math.max(0, geometry.trackHeight)

  target.style.setProperty(
    '--raw-compare-split',
    `${roundForCss(clipSplit * 100)}%`,
  )
  target.style.setProperty('--raw-compare-split-x', `${roundForCss(handleX)}px`)
  target.style.setProperty('--raw-compare-track-top', `${roundForCss(top)}px`)
  target.style.setProperty(
    '--raw-compare-track-height',
    `${roundForCss(height)}px`,
  )

  const frame = target.parentElement
  if (frame) applyFrameSplitVariables(frame, clipSplit, handleX, geometry)
}

function applyFrameSplitVariables(
  frame: HTMLElement,
  clipSplit: number,
  handleX: number,
  geometry: TrackGeometry,
) {
  const top = Math.max(0, geometry.trackTop)
  const height = Math.max(0, geometry.trackHeight)
  // Distance from the frame's bottom edge up to the photo. The RAW / JPEG
  // labels hang off this so they sit on the photograph instead of floating
  // in the mat below it.
  const trackBottom = `${roundForCss(
    Math.max(0, geometry.frameRect.height - (top + height)),
  )}px`

  frame.style.setProperty(
    '--raw-compare-split',
    `${roundForCss(clipSplit * 100)}%`,
  )
  frame.style.setProperty('--raw-compare-split-x', `${roundForCss(handleX)}px`)
  frame.style.setProperty('--raw-compare-track-bottom', trackBottom)
}

function trySetPointerCapture(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // Synthetic pointer events and a few edge paths can lack an active pointer.
  }
}

function tryReleasePointerCapture(target: HTMLElement, pointerId: number) {
  try {
    target.releasePointerCapture?.(pointerId)
  } catch {
    // Release is best-effort; internal active pointer state is authoritative.
  }
}

export const CompareSplitHandle = memo(
  ({
    value,
    onChange,
    onReset,
    disabled = false,
    className,
  }: {
    value: number
    /**
     * Commits a split. Dragging only paints the handle and the clip; the split
     * is committed once, when the gesture completes (release or a key press).
     */
    onChange: (value: number) => void
    /**
     * The compare reset, run by a double-click (mouse) or double-tap (touch /
     * pen) and shared by both viewports. It owns the 50% write; without it the
     * handle commits 50% itself.
     */
    onReset?: () => void
    disabled?: boolean
    className?: string
  }) => {
    const { t } = useI18n()
    const handleRef = useRef<HTMLButtonElement>(null)
    const activePointerIdRef = useRef<number | null>(null)
    const dragFrameRef = useRef<HTMLElement | null>(null)
    const pressStartRef = useRef<{ x: number; y: number } | null>(null)
    const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(
      null,
    )
    const lastPointerTypeRef = useRef<string | null>(null)
    const pendingClientXRef = useRef<number | null>(null)
    const pendingAnimationFrameRef = useRef<number | null>(null)
    const committedSplitRef = useRef(clampCompareSplit(value))
    const latestPreviewSplitRef = useRef(clampCompareSplit(value))

    useLayoutEffect(() => {
      const handle = handleRef.current
      committedSplitRef.current = clampCompareSplit(value)
      if (!handle) return

      if (activePointerIdRef.current === null) {
        latestPreviewSplitRef.current = committedSplitRef.current
        applyHandlePosition(handle, value)
      }

      if (typeof ResizeObserver === 'undefined') return

      const frame = handle.parentElement
      const imageTrack = frame?.querySelector<HTMLElement>(IMAGE_TRACK_SELECTOR)
      const observer = new ResizeObserver(() => {
        applyHandlePosition(handle, latestPreviewSplitRef.current)
      })

      if (frame) observer.observe(frame)
      if (imageTrack) observer.observe(imageTrack)

      return () => {
        observer.disconnect()
      }
    })

    const cancelPendingPreview = useCallback(() => {
      pendingClientXRef.current = null
      const frame = pendingAnimationFrameRef.current
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        pendingAnimationFrameRef.current = null
      }
    }, [])

    const previewFromPointer = useCallback(
      (target: HTMLElement, clientX: number) => {
        const split = applyPointerPosition(target, clientX)
        latestPreviewSplitRef.current = split
        return split
      },
      [],
    )

    const schedulePointerPreview = useCallback(
      (target: HTMLElement, clientX: number) => {
        pendingClientXRef.current = clientX

        if (pendingAnimationFrameRef.current !== null) return

        pendingAnimationFrameRef.current = window.requestAnimationFrame(() => {
          pendingAnimationFrameRef.current = null
          const nextClientX = pendingClientXRef.current
          if (nextClientX === null) return
          previewFromPointer(target, nextClientX)
        })
      },
      [previewFromPointer],
    )

    const flushPointerPreview = useCallback(
      (target: HTMLElement, clientX: number) => {
        cancelPendingPreview()
        return previewFromPointer(target, clientX)
      },
      [cancelPendingPreview, previewFromPointer],
    )

    const setFrameDragging = useCallback(
      (target: HTMLElement, active: boolean) => {
        const frame = active ? target.parentElement : dragFrameRef.current
        dragFrameRef.current = active ? frame : null
        if (!frame) return
        if (active) {
          frame.setAttribute('data-raw-compare-dragging', '')
        } else {
          frame.removeAttribute('data-raw-compare-dragging')
        }
      },
      [],
    )

    // Paints the last committed split again, dropping any transient drag
    // position.
    const restoreCommittedSplit = useCallback((target: HTMLElement) => {
      latestPreviewSplitRef.current = committedSplitRef.current
      applyHandlePosition(target, committedSplitRef.current)
    }, [])

    // Ends an unfinished drag without committing it: cancel, lost capture,
    // disable and unmount all land back on the committed split.
    const abandonDrag = useCallback(
      (target: HTMLElement | null) => {
        const pointerId = activePointerIdRef.current
        cancelPendingPreview()
        pressStartRef.current = null
        lastTapRef.current = null
        if (pointerId === null) return

        activePointerIdRef.current = null
        if (target) {
          setFrameDragging(target, false)
          tryReleasePointerCapture(target, pointerId)
          restoreCommittedSplit(target)
        } else {
          // The handle is gone but the frame can outlive it: put the committed
          // split back on the frame so nothing keeps showing the abandoned drag.
          const frame = dragFrameRef.current
          dragFrameRef.current = null
          if (frame) {
            frame.removeAttribute('data-raw-compare-dragging')
            applyFramePosition(frame, committedSplitRef.current)
          }
        }
      },
      [cancelPendingPreview, restoreCommittedSplit, setFrameDragging],
    )

    useEffect(() => {
      if (disabled) abandonDrag(handleRef.current)
    }, [abandonDrag, disabled])

    useEffect(() => {
      return () => {
        abandonDrag(null)
      }
    }, [abandonDrag])

    // One reset transaction: the compare reset when wired, else a single 50%
    // commit. The handle shows the committed split meanwhile; the reset's own
    // re-render moves it, and a refused reset leaves it where the split is.
    const resetSplit = useCallback(
      (target: HTMLElement) => {
        cancelPendingPreview()
        restoreCommittedSplit(target)
        if (onReset) {
          onReset()
        } else {
          onChange(RESET_SPLIT)
        }
      },
      [cancelPendingPreview, onChange, onReset, restoreCommittedSplit],
    )

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        lastPointerTypeRef.current = event.pointerType
        if (disabled) return

        pressStartRef.current = { x: event.clientX, y: event.clientY }
        trySetPointerCapture(event.currentTarget, event.pointerId)
        activePointerIdRef.current = event.pointerId
        setFrameDragging(event.currentTarget, true)
        schedulePointerPreview(event.currentTarget, event.clientX)
      },
      [disabled, schedulePointerPreview, setFrameDragging],
    )

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (disabled || activePointerIdRef.current !== event.pointerId) {
          return
        }

        schedulePointerPreview(event.currentTarget, event.clientX)
      },
      [disabled, schedulePointerPreview],
    )

    const handlePointerUp = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (disabled || activePointerIdRef.current !== event.pointerId) return

        const target = event.currentTarget
        const start = pressStartRef.current
        pressStartRef.current = null
        activePointerIdRef.current = null
        setFrameDragging(target, false)
        tryReleasePointerCapture(target, event.pointerId)

        if (event.pointerType === 'touch' || event.pointerType === 'pen') {
          const travelled = start
            ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
            : 0
          const now = Date.now()
          const last = lastTapRef.current
          if (travelled > DOUBLE_TAP_SLOP_PX) {
            // A drag, not a tap.
            lastTapRef.current = null
          } else if (
            last &&
            now - last.time <= DOUBLE_TAP_MS &&
            Math.hypot(event.clientX - last.x, event.clientY - last.y) <=
              DOUBLE_TAP_SLOP_PX
          ) {
            // The second tap is the reset, not a split commit of its own.
            lastTapRef.current = null
            resetSplit(target)
            return
          } else {
            lastTapRef.current = {
              time: now,
              x: event.clientX,
              y: event.clientY,
            }
          }
        }

        onChange(flushPointerPreview(target, event.clientX))
      },
      [disabled, flushPointerPreview, onChange, resetSplit, setFrameDragging],
    )

    const handlePointerCancel = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (activePointerIdRef.current !== event.pointerId) return
        abandonDrag(event.currentTarget)
      },
      [abandonDrag],
    )

    const handleLostPointerCapture = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        // Capture lost without a release (the element moved, the page hid):
        // end the drag the same way a cancel does. A release clears the active
        // pointer before it lets capture go, so it never lands here.
        if (activePointerIdRef.current !== event.pointerId) return
        abandonDrag(event.currentTarget)
      },
      [abandonDrag],
    )

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLButtonElement>) => {
        event.stopPropagation()
        if (disabled) return

        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          onChange(clampCompareSplit(clampCompareSplit(value) - KEYBOARD_STEP))
        } else if (event.key === 'ArrowRight') {
          event.preventDefault()
          onChange(clampCompareSplit(clampCompareSplit(value) + KEYBOARD_STEP))
        } else if (event.key === 'Home') {
          event.preventDefault()
          onChange(MIN_SPLIT)
        } else if (event.key === 'End') {
          event.preventDefault()
          onChange(MAX_SPLIT)
        }
      },
      [disabled, onChange, value],
    )

    const handleDoubleClick = useCallback(
      (event: React.MouseEvent<HTMLButtonElement>) => {
        // Keep the stage's own double-click (viewport reset) out of this.
        event.stopPropagation()
        event.preventDefault()
        if (disabled) return
        // Touch and pen reset through the double-tap path; a synthesized
        // dblclick after it must not reset twice.
        const pointerType = lastPointerTypeRef.current
        if (pointerType === 'touch' || pointerType === 'pen') return
        resetSplit(event.currentTarget)
      },
      [disabled, resetSplit],
    )

    const stopInteractionPropagation = useCallback(
      (event: React.SyntheticEvent<HTMLButtonElement>) => {
        event.stopPropagation()
      },
      [],
    )

    const ariaValueNow = Math.round(clampCompareSplit(value) * 100)

    return (
      <button
        ref={handleRef}
        type="button"
        role="slider"
        aria-label={t('raw.stage.sliderAria')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ariaValueNow}
        disabled={disabled}
        className={clsxm('raw-lab-compare-handle', className)}
        style={
          {
            '--raw-compare-split': `${clampCompareSplit(value) * 100}%`,
          } as React.CSSProperties
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onClick={stopInteractionPropagation}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <span aria-hidden="true">↔</span>
      </button>
    )
  },
)
