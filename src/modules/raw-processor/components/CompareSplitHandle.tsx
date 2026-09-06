import { useCallback, useLayoutEffect, useRef } from 'react'

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
  const frame = target.parentElement ?? target
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
  const { split, clipSplit, handleX, geometry } =
    getCompareSplitPositionGeometry(target, value)
  applyCompareSplitVariables(target, split, clipSplit, handleX, geometry)
}

function applyPointerPosition(target: HTMLElement, clientX: number) {
  const { split, clipSplit, handleX, geometry } =
    getCompareSplitInteractionGeometry(target, clientX)
  applyCompareSplitVariables(target, split, clipSplit, handleX, geometry)
  return split
}

function roundForCss(value: number) {
  return Number(value.toFixed(4))
}

function applyCompareSplitVariables(
  target: HTMLElement,
  _split: number,
  clipSplit: number,
  handleX: number,
  geometry: TrackGeometry,
) {
  const clipSplitPercent = `${roundForCss(clipSplit * 100)}%`
  const handlePosition = `${roundForCss(handleX)}px`
  // The photo is letterboxed inside the frame. Publishing its vertical box
  // lets the split line stop at the photograph instead of running through
  // the empty mat above and below it.
  const top = Math.max(0, geometry.trackTop)
  const height = Math.max(0, geometry.trackHeight)
  const trackTop = `${roundForCss(top)}px`
  const trackHeight = `${roundForCss(height)}px`
  // Distance from the frame's bottom edge up to the photo. The RAW / JPEG
  // labels hang off this so they sit on the photograph instead of floating
  // in the mat below it.
  const trackBottom = `${roundForCss(
    Math.max(0, geometry.frameRect.height - (top + height)),
  )}px`

  target.style.setProperty('--raw-compare-split', clipSplitPercent)
  target.style.setProperty('--raw-compare-split-x', handlePosition)
  target.style.setProperty('--raw-compare-track-top', trackTop)
  target.style.setProperty('--raw-compare-track-height', trackHeight)

  const frame = target.parentElement
  frame?.style.setProperty('--raw-compare-split', clipSplitPercent)
  frame?.style.setProperty('--raw-compare-split-x', handlePosition)
  frame?.style.setProperty('--raw-compare-track-bottom', trackBottom)
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

export function CompareSplitHandle({
  value,
  onChange,
  onPreviewChange,
  disabled = false,
  className,
}: {
  value: number
  onChange: (value: number) => void
  onPreviewChange?: (value: number) => void
  disabled?: boolean
  className?: string
}) {
  const { t } = useI18n()
  const handleRef = useRef<HTMLButtonElement>(null)
  const activePointerIdRef = useRef<number | null>(null)
  const pendingClientXRef = useRef<number | null>(null)
  const pendingAnimationFrameRef = useRef<number | null>(null)
  const latestPreviewSplitRef = useRef(clampCompareSplit(value))

  useLayoutEffect(() => {
    const handle = handleRef.current
    if (!handle) return

    if (activePointerIdRef.current === null) {
      latestPreviewSplitRef.current = clampCompareSplit(value)
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
      onPreviewChange?.(split)
      return split
    },
    [onPreviewChange],
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
      pendingClientXRef.current = null
      cancelPendingPreview()
      return previewFromPointer(target, clientX)
    },
    [cancelPendingPreview, previewFromPointer],
  )

  const setFrameDragging = useCallback(
    (target: HTMLElement, active: boolean) => {
      const frame = target.parentElement
      if (!frame) return
      if (active) {
        frame.setAttribute('data-raw-compare-dragging', '')
      } else {
        frame.removeAttribute('data-raw-compare-dragging')
      }
    },
    [],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (disabled) return

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

      const nextSplit = flushPointerPreview(event.currentTarget, event.clientX)
      activePointerIdRef.current = null
      setFrameDragging(event.currentTarget, false)
      tryReleasePointerCapture(event.currentTarget, event.pointerId)
      onChange(nextSplit)
    },
    [disabled, flushPointerPreview, onChange, setFrameDragging],
  )

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      if (activePointerIdRef.current !== event.pointerId) return

      activePointerIdRef.current = null
      pendingClientXRef.current = null
      cancelPendingPreview()
      setFrameDragging(event.currentTarget, false)
      tryReleasePointerCapture(event.currentTarget, event.pointerId)
      applyHandlePosition(event.currentTarget, value)
    },
    [cancelPendingPreview, value, setFrameDragging],
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
      onClick={stopInteractionPropagation}
      onKeyDown={handleKeyDown}
    >
      <span aria-hidden="true">↔</span>
    </button>
  )
}
