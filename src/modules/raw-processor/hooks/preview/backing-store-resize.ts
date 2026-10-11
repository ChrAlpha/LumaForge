/** A CSS box size in layout pixels. */
interface BoxSize {
  width: number
  height: number
}

/** A canvas backing store size in device pixels. */
interface BackingStoreSize {
  width: number
  height: number
}

/** Trailing delay before a GPU canvas backing store follows a layout resize. */
export const BACKING_STORE_SETTLE_MS = 90

/** Device pixel ratio of GPU backing stores: capped at 2, and 1 when unknown. */
function backingStorePixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 2)
}

/**
 * The largest box with the source aspect ratio that fits the container, or
 * the container itself while the source has no size.
 */
export function aspectFitBox(container: BoxSize, source: BoxSize): BoxSize {
  if (source.width <= 0 || source.height <= 0) {
    return { width: container.width, height: container.height }
  }
  const aspectRatio = source.width / source.height
  const containerAspect = container.width / container.height
  if (aspectRatio > containerAspect) {
    return { width: container.width, height: container.width / aspectRatio }
  }
  return { width: container.height * aspectRatio, height: container.height }
}

/** Device pixels for a CSS box, rounded and never below `minimum`. */
export function backingStoreSize(box: BoxSize, minimum = 0): BackingStoreSize {
  const ratio = backingStorePixelRatio()
  return {
    width: Math.max(minimum, Math.round(box.width * ratio)),
    height: Math.max(minimum, Math.round(box.height * ratio)),
  }
}

export interface SettledBackingStoreOptions {
  /**
   * The backing store size for an observed content box. It runs on every
   * observation, so a caller may also lay out its elements here.
   */
  measure: (contentRect: DOMRectReadOnly) => BackingStoreSize
  /** Runs once the canvas holds the applied size, to resize and redraw. */
  onApply: () => void
  /** Whether a later size applies at once instead of after it settles. */
  applyImmediately?: () => boolean
}

/**
 * Keeps the canvas backing store in step with the target's content box.
 *
 * The first size applies at once. Later sizes apply only once they have
 * settled for `BACKING_STORE_SETTLE_MS`: a stage that animates its insets
 * would otherwise cost a full GPU pass per animation frame, and in between
 * CSS scales the canvas. The returned teardown disconnects and flushes a
 * pending size, so a remount never leaves a stale backing store behind.
 */
export function observeSettledBackingStore(
  target: Element,
  canvas: HTMLCanvasElement,
  { measure, onApply, applyImmediately }: SettledBackingStoreOptions,
): () => void {
  let settleTimer: number | null = null
  let pending: BackingStoreSize | null = null
  let hasFitOnce = false

  const applyBackingStore = () => {
    const next = pending
    pending = null
    if (!next) return
    // Assigning a canvas size clears it, even to the same value.
    if (canvas.width !== next.width || canvas.height !== next.height) {
      canvas.width = next.width
      canvas.height = next.height
    }
    onApply()
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      pending = measure(entry.contentRect)
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer)
        settleTimer = null
      }
      if (!hasFitOnce || applyImmediately?.()) {
        hasFitOnce = true
        applyBackingStore()
        continue
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null
        applyBackingStore()
      }, BACKING_STORE_SETTLE_MS)
    }
  })

  resizeObserver.observe(target)

  return () => {
    resizeObserver.disconnect()
    if (settleTimer !== null) {
      window.clearTimeout(settleTimer)
      settleTimer = null
      applyBackingStore()
    }
  }
}
