import { useEffect, useRef } from 'react'

/** Hold time that turns a press into a peek; shared by photo and lens. */
export const LONG_PRESS_MS = 250
/** Travel that turns a press into a pan instead of a tap or peek. */
export const TAP_SLOP_PX = 8

type ActivePointer = {
  startX: number
  startY: number
}

export interface MobilePreviewGestureOptions {
  enabled: boolean
  /**
   * When false the long-press peek does not fire, but a short tap still
   * resolves to `onTap` — used in Compare-split mode, where the RAW vs
   * finished view is owned by the split handle instead.
   */
  allowPeek?: boolean
  onPeekChange: (peeking: boolean) => void
  onTap?: () => void
}

/**
 * Attaches single-finger long-press / tap detection to the supplied
 * preview frame element. Cancels itself the moment a second pointer
 * touches the same element so the existing pinch / pan listeners in
 * `PreviewCanvas` keep ownership of multi-touch on the same DOM node.
 *
 * Also suppresses the browser's long-press context menu / image callout
 * via a `contextmenu` preventDefault on the same element.
 */
export function useMobilePreviewGestures(
  targetEl: HTMLElement | null,
  options: MobilePreviewGestureOptions,
) {
  const { enabled, allowPeek = true, onPeekChange, onTap } = options
  const onPeekChangeRef = useRef(onPeekChange)
  const onTapRef = useRef(onTap)

  useEffect(() => {
    onPeekChangeRef.current = onPeekChange
  }, [onPeekChange])
  useEffect(() => {
    onTapRef.current = onTap
  }, [onTap])

  useEffect(() => {
    if (!targetEl || !enabled) return

    const active = new Map<number, ActivePointer>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let peeking = false
    let pressIntent = false
    let cancelled = false

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }

    const cancelPeek = () => {
      clearTimer()
      pressIntent = false
      cancelled = true
      if (peeking) {
        peeking = false
        onPeekChangeRef.current(false)
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      // Only react to primary mouse button. Touch/pen primary buttons report 0.
      if (event.pointerType === 'mouse' && event.button !== 0) return

      active.set(event.pointerId, {
        startX: event.clientX,
        startY: event.clientY,
      })

      if (active.size >= 2) {
        // Multi-touch (pinch) takes over — release any single-finger intent
        // and let `PreviewCanvas`'s own pointer handlers (attached via React
        // on the same element) drive the gesture.
        cancelPeek()
        return
      }

      pressIntent = true
      cancelled = false
      clearTimer()
      if (!allowPeek) {
        // Compare-split mode owns RAW-vs-finished — long-press peek is
        // suppressed, but a short tap still toggles immersive. A press
        // held past LONG_PRESS_MS is consumed (no tap, no peek).
        timer = setTimeout(() => {
          timer = null
          if (active.size === 1) pressIntent = false
        }, LONG_PRESS_MS)
        return
      }
      timer = setTimeout(() => {
        timer = null
        if (cancelled || active.size !== 1) return
        peeking = true
        pressIntent = false
        onPeekChangeRef.current(true)
      }, LONG_PRESS_MS)
    }

    const onPointerMove = (event: PointerEvent) => {
      const tracked = active.get(event.pointerId)
      if (!tracked) return

      if (cancelled || active.size !== 1) return

      const dx = event.clientX - tracked.startX
      const dy = event.clientY - tracked.startY
      if (Math.hypot(dx, dy) > TAP_SLOP_PX) {
        // A pan/scroll intent — never a tap or peek.
        cancelPeek()
      }
    }

    const finishPointer = (event: PointerEvent) => {
      if (!active.has(event.pointerId)) return
      active.delete(event.pointerId)

      if (active.size > 0) {
        // Some fingers still down — wait for full release before deciding.
        return
      }

      if (peeking) {
        peeking = false
        onPeekChangeRef.current(false)
      } else if (pressIntent && !cancelled) {
        // Released before the long-press threshold without slop → tap.
        onTapRef.current?.()
      }
      clearTimer()
      pressIntent = false
      cancelled = false
    }

    const onContextMenu = (event: Event) => {
      // Suppress the browser long-press image callout / context menu so
      // a held finger does not trigger a "Save Image" sheet or text
      // selection ring over the preview.
      event.preventDefault()
    }

    targetEl.addEventListener('pointerdown', onPointerDown)
    targetEl.addEventListener('pointermove', onPointerMove)
    targetEl.addEventListener('pointerup', finishPointer)
    targetEl.addEventListener('pointercancel', finishPointer)
    targetEl.addEventListener('contextmenu', onContextMenu)

    return () => {
      targetEl.removeEventListener('pointerdown', onPointerDown)
      targetEl.removeEventListener('pointermove', onPointerMove)
      targetEl.removeEventListener('pointerup', finishPointer)
      targetEl.removeEventListener('pointercancel', finishPointer)
      targetEl.removeEventListener('contextmenu', onContextMenu)
      clearTimer()
      if (peeking) {
        peeking = false
        onPeekChangeRef.current(false)
      }
    }
  }, [targetEl, enabled, allowPeek])
}
