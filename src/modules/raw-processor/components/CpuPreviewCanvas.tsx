/**
 * 2D canvas component for rendering CPU-decoded RAW preview frames.
 *
 * Rendering contract:
 *   - putImageData onto a backing canvas (at frame pixel size) to avoid
 *     2D-transform corruption of raw pixel data.
 *   - drawImage(backing, ...) onto the visible canvas with aspect-fit scaling.
 *   - Never use ctx.scale() + putImageData on the visible canvas.
 */

import type {
  CpuPreviewFailureReason,
  CpuPreviewFrame,
} from '@lumaforge/render-engine/preview'
import { useCallback, useEffect, useRef } from 'react'

import { LoadingCircle } from '~/components/ui/loading'
import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'

/** Trailing delay before a resized canvas is redrawn at its new box. */
export const CPU_CANVAS_RESIZE_SETTLE_MS = 90

export interface CpuPreviewCanvasProps {
  frame: CpuPreviewFrame | null
  inFlight: boolean
  fallbackThumbnailUrl?: string | null
  failureReason?: CpuPreviewFailureReason | null
  className?: string
}

export function CpuPreviewCanvas({
  frame,
  inFlight,
  fallbackThumbnailUrl,
  failureReason,
  className,
}: CpuPreviewCanvasProps) {
  const { t } = useI18n()
  const visibleRef = useRef<HTMLCanvasElement>(null)
  const backingRef = useRef<HTMLCanvasElement | null>(null)
  const frameRef = useRef<CpuPreviewFrame | null>(null)

  // Lazily create the backing canvas once
  if (!backingRef.current) {
    backingRef.current = document.createElement('canvas')
  }

  // Present the backing canvas on the visible one, aspect-fit to the
  // visible canvas's current box. Runs on every new frame and again when the
  // box settles after a resize, so a stage that grows or shrinks around the
  // photo never leaves it stretched.
  const present = useCallback((current: CpuPreviewFrame) => {
    const visible = visibleRef.current
    const backing = backingRef.current
    if (!visible || !backing) return

    const visibleCtx = visible.getContext('2d')
    if (!visibleCtx) return

    const containerWidth = visible.clientWidth || visible.width
    const containerHeight = visible.clientHeight || visible.height
    if (!(containerWidth > 0) || !(containerHeight > 0)) return

    const aspectRatio = current.width / current.height
    const containerAspect = containerWidth / containerHeight

    let destW: number
    let destH: number
    if (aspectRatio > containerAspect) {
      destW = containerWidth
      destH = containerWidth / aspectRatio
    } else {
      destH = containerHeight
      destW = containerHeight * aspectRatio
    }

    const dpr = Math.min(
      typeof window !== 'undefined' ? window.devicePixelRatio : 1,
      2,
    )
    visible.width = Math.round(containerWidth * dpr)
    visible.height = Math.round(containerHeight * dpr)

    visibleCtx.clearRect(0, 0, visible.width, visible.height)
    visibleCtx.drawImage(
      backing,
      0,
      0,
      current.width,
      current.height,
      Math.round(((containerWidth - destW) / 2) * dpr),
      Math.round(((containerHeight - destH) / 2) * dpr),
      Math.round(destW * dpr),
      Math.round(destH * dpr),
    )
  }, [])

  useEffect(() => {
    const visible = visibleRef.current
    const backing = backingRef.current
    if (!frame || !visible || !backing) return

    // Size the backing canvas to the exact frame dimensions
    backing.width = frame.width
    backing.height = frame.height

    const backingCtx = backing.getContext('2d')
    if (!backingCtx) return

    // putImageData onto the backing canvas at native frame size.
    // Construct ImageData defensively for jsdom compatibility:
    //   1. Try the standard ImageData(data, width, height) constructor.
    //   2. Fall back to createImageData + manual copy.
    //   3. If the context mock doesn't provide createImageData (test env),
    //      build a minimal ImageData-shaped object for putImageData.
    let imageData: ImageData
    try {
      imageData = new ImageData(
        frame.rgba as Uint8ClampedArray<ArrayBuffer>,
        frame.width,
        frame.height,
      )
    } catch {
      if (typeof backingCtx.createImageData === 'function') {
        imageData = backingCtx.createImageData(frame.width, frame.height)
        imageData.data.set(frame.rgba)
      } else {
        // Minimal fallback for environments where both paths are unavailable
        // (e.g. mocked canvas in jsdom tests). Build a plain object that
        // satisfies the putImageData call so the rendering path executes.
        imageData = {
          data: frame.rgba,
          width: frame.width,
          height: frame.height,
          colorSpace: 'srgb' as PredefinedColorSpace,
        } as ImageData
      }
    }
    backingCtx.putImageData(imageData, 0, 0)
    frameRef.current = frame
    present(frame)
  }, [frame, present])

  // The stage insets animate over ~240ms; redraw once the box has settled
  // (90ms trailing, like the GPU layers' backing-store resize) rather than
  // per frame. Until then `object-contain` keeps the last draw undistorted.
  const hasFrame = frame !== null
  useEffect(() => {
    const visible = visibleRef.current
    if (!hasFrame || !visible || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        if (frameRef.current) present(frameRef.current)
      }, CPU_CANVAS_RESIZE_SETTLE_MS)
    })
    observer.observe(visible)
    return () => {
      observer.disconnect()
      if (timer !== null) clearTimeout(timer)
    }
  }, [hasFrame, present])

  // No frame: show fallback thumbnail or failure placeholder
  if (!frame) {
    if (fallbackThumbnailUrl) {
      return (
        <div
          className={clsxm(
            'relative flex items-center justify-center w-full h-full bg-[var(--color-preview-mat)]',
            className,
          )}
        >
          <img
            src={fallbackThumbnailUrl}
            alt={t('raw.preview.embeddedAlt')}
            className="max-w-full max-h-full object-contain"
            draggable={false}
          />
          {inFlight && (
            <div
              data-testid="cpu-preview-spinner"
              className="absolute inset-0 flex items-center justify-center pointer-events-none"
              aria-live="polite"
              aria-label={t('raw.progress.processing')}
            >
              <LoadingCircle
                size="small"
                className="text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/60))]"
              />
            </div>
          )}
        </div>
      )
    }

    if (inFlight && !failureReason) {
      return (
        <div
          className={clsxm(
            'relative flex items-center justify-center w-full h-full bg-[var(--color-preview-mat)]',
            className,
          )}
        >
          <div
            data-testid="cpu-preview-spinner"
            className="flex flex-col items-center gap-3 text-center"
            aria-live="polite"
            aria-label={t('raw.progress.processing')}
          >
            <LoadingCircle
              size="small"
              className="text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/60))]"
            />
            <span className="text-sm text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/60))]">
              {t('raw.progress.processing')}
            </span>
          </div>
        </div>
      )
    }

    return (
      <div
        className={clsxm(
          'relative flex items-center justify-center w-full h-full bg-[var(--color-preview-mat)]',
          className,
        )}
      >
        <div
          data-testid="cpu-preview-unavailable"
          className="flex flex-col items-center gap-3 text-center"
        >
          <i className="i-mingcute-camera-off-line text-3xl text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/40))]" />
          <span className="text-sm text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/60))]">
            {t('raw.preview.cpuDegraded.unavailable')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={clsxm(
        'relative w-full h-full bg-[var(--color-preview-mat)]',
        className,
      )}
    >
      <canvas
        ref={visibleRef}
        className="w-full h-full object-contain"
        aria-label={t('raw.preview.embeddedAlt')}
      />

      {inFlight && (
        <div
          data-testid="cpu-preview-spinner"
          className="absolute inset-0 flex items-center justify-center pointer-events-none"
          aria-live="polite"
          aria-label={t('raw.progress.processing')}
        >
          <LoadingCircle
            size="small"
            className="text-[var(--color-on-stage-soft,theme(colors.lf-on-photo-ink/60))]"
          />
        </div>
      )}
    </div>
  )
}
