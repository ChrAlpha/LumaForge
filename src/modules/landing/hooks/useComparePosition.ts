import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

export const COMPARE_MIN_POSITION = 0.02
export const COMPARE_MAX_POSITION = 0.98
export const COMPARE_REST_POSITION = 0.5

/** Muted share of the frame when the page first paints with the sweep armed. */
export const COMPARE_SWEEP_FROM = 0.86
const SWEEP_DELAY_MS = 240
const SWEEP_DURATION_MS = 1100
/** If the finished image has not loaded by then, rest at the centre instead. */
const SWEEP_LOAD_TIMEOUT_MS = 4000

function easeOutExpo(t: number) {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)
}

function sweepAllowed() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: no-preference)').matches
  )
}

/**
 * Owns the split position of the landing compare.
 *
 * With motion allowed, the first paint shows the muted treatment over most of
 * the frame and, once the finished image has loaded, the finish wipes in to
 * the centre once. Any pointer or keyboard input cancels the sweep and the
 * control answers to the user immediately. Under reduced motion, or when
 * `matchMedia` is unavailable (jsdom), the split simply rests at the centre.
 */
export function useComparePosition({
  sweep,
  imageRef,
}: {
  sweep: boolean
  imageRef: RefObject<HTMLImageElement | null>
}) {
  const [position, setPosition] = useState(() =>
    sweep && sweepAllowed() ? COMPARE_SWEEP_FROM : COMPARE_REST_POSITION,
  )
  const stopRef = useRef<(() => void) | null>(null)

  const cancelSweep = useCallback(() => {
    stopRef.current?.()
  }, [])

  useEffect(() => {
    if (!sweep || !sweepAllowed()) return
    const image = imageRef.current
    if (!image) return

    let active = true
    let delayTimer: number | null = null
    let loadTimer: number | null = null
    let frame: number | null = null

    const stop = () => {
      active = false
      if (delayTimer !== null) window.clearTimeout(delayTimer)
      if (loadTimer !== null) window.clearTimeout(loadTimer)
      if (frame !== null) cancelAnimationFrame(frame)
      delayTimer = loadTimer = frame = null
    }

    const play = () => {
      if (!active) return
      const start = performance.now()
      const step = (now: number) => {
        if (!active) return
        const t = Math.min(1, (now - start) / SWEEP_DURATION_MS)
        setPosition(
          COMPARE_SWEEP_FROM +
            (COMPARE_REST_POSITION - COMPARE_SWEEP_FROM) * easeOutExpo(t),
        )
        frame = t < 1 ? requestAnimationFrame(step) : null
      }
      frame = requestAnimationFrame(step)
    }

    const arm = () => {
      if (!active) return
      if (loadTimer !== null) window.clearTimeout(loadTimer)
      loadTimer = null
      delayTimer = window.setTimeout(play, SWEEP_DELAY_MS)
    }

    const rest = () => {
      if (!active) return
      stop()
      setPosition(COMPARE_REST_POSITION)
    }

    stopRef.current = stop

    if (image.complete && image.naturalWidth > 0) {
      arm()
    } else {
      image.addEventListener('load', arm, { once: true })
      image.addEventListener('error', rest, { once: true })
      loadTimer = window.setTimeout(rest, SWEEP_LOAD_TIMEOUT_MS)
    }

    return () => {
      stop()
      stopRef.current = null
      image.removeEventListener('load', arm)
      image.removeEventListener('error', rest)
    }
  }, [sweep, imageRef])

  return { position, setPosition, cancelSweep }
}
