import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ScrubGainBand, ScrubSession } from './slider-scrub-model'
import { createScrubSession } from './slider-scrub-model'

/**
 * Momentum decay per animation frame after a forwarded scroll flick, and the
 * velocity (px/ms) below which the glide stops.
 */
const SCROLL_MOMENTUM_DECAY = 0.94
const SCROLL_MOMENTUM_MIN_VELOCITY = 0.02

function findScrollableAncestor(start: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = start
  while (node) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    const overflowY = style?.overflowY
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

export interface UseSliderScrubOptions {
  value: number
  min: number
  max: number
  step: number
  /**
   * The value a field returns to. Defaults to 0, which every /raw field uses
   * today; the sticky-zero park and the tap capture window both anchor here.
   */
  neutral?: number
  disabled?: boolean
  onChange: (value: number) => void
  /** Fires once when a scrub locks and once when it ends. Taps do not scrub. */
  onScrubChange?: (scrubbing: boolean) => void
  /** Fires whenever the touch gain band changes during a scrub. */
  onGainChange?: (gain: ScrubGainBand) => void
  /** Double-click (mouse) on the row. */
  onReset?: () => void
}

export interface SliderScrubBind {
  ref: (element: HTMLElement | null) => void
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void
  onDoubleClick: () => void
}

const TRACK_SELECTOR = '[data-slot="slider-track"]'
const THUMB_SELECTOR = '[role="slider"]'
/**
 * Controls inside a row that own their own press: the reset value, and any
 * future affordance a row grows. Without this the row would start a scrub
 * (jumping the value to the pointer) a frame before the control's click ran.
 */
const INTERACTIVE_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [data-scrub-ignore]'

function readTrackGeometry(host: HTMLElement | null) {
  const track = host?.querySelector<HTMLElement>(TRACK_SELECTOR) ?? null
  const rect = track?.getBoundingClientRect()
  if (!rect || !(rect.width > 0)) {
    return { left: 0, width: 0, centerY: 0 }
  }
  return {
    left: rect.left,
    width: rect.width,
    centerY: rect.top + rect.height / 2,
  }
}

/**
 * Drop the browser's implicit touch pointer capture from the pressed element.
 *
 * Chromium implicitly captures a touch pointer to the pointerdown target, and
 * the Radix Slider root moves the value from any `pointermove` whose target
 * still holds that capture. Blocking Radix's `pointerdown` is therefore not
 * enough: without this release, Radix keeps sliding the thumb underneath our
 * own scrub model and the two fight over the value.
 */
function releaseImplicitCapture(target: EventTarget | null, pointerId: number) {
  const element = target as HTMLElement | null
  try {
    if (element?.hasPointerCapture?.(pointerId)) {
      element.releasePointerCapture?.(pointerId)
    }
  } catch {
    // Best effort; the session state is authoritative.
  }
}

/**
 * Pointer interaction for an Adjust slider row. Intercepts pointerdown in the
 * capture phase so the Radix Slider never starts its own absolute drag, then
 * drives `slider-scrub-model` from pointer moves. The Radix thumb keeps
 * keyboard and screen-reader behaviour.
 */
export function useSliderScrub(options: UseSliderScrubOptions) {
  const {
    value,
    min,
    max,
    step,
    neutral = 0,
    disabled = false,
    onChange,
    onScrubChange,
    onGainChange,
    onReset,
  } = options
  const hostRef = useRef<HTMLElement | null>(null)
  const sessionRef = useRef<ScrubSession | null>(null)
  const glideFrameRef = useRef<number | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  const lastEmittedRef = useRef<number | null>(null)
  const lastGainRef = useRef<ScrubGainBand>('full')
  const valueRef = useRef(value)
  valueRef.current = value
  const [scrubbing, setScrubbing] = useState(false)
  const [gain, setGain] = useState<ScrubGainBand>('full')

  const latest = useRef({ onChange, onScrubChange, onGainChange, onReset })
  useEffect(() => {
    latest.current = { onChange, onScrubChange, onGainChange, onReset }
  }, [onChange, onScrubChange, onGainChange, onReset])

  const emitValue = useCallback((next: number) => {
    if (lastEmittedRef.current === next) return
    lastEmittedRef.current = next
    if (next !== valueRef.current) {
      latest.current.onChange(next)
    }
  }, [])

  const emitGain = useCallback((next: ScrubGainBand) => {
    if (lastGainRef.current === next) return
    lastGainRef.current = next
    setGain(next)
    latest.current.onGainChange?.(next)
  }, [])

  const teardownRef = useRef<(() => void) | null>(null)

  const stopGlide = useCallback(() => {
    const frame = glideFrameRef.current
    if (frame === null) return
    glideFrameRef.current = null
    hostRef.current?.ownerDocument.defaultView?.cancelAnimationFrame(frame)
  }, [])

  const finish = useCallback(
    (wasScrubbing: boolean) => {
      sessionRef.current = null
      pointerIdRef.current = null
      lastEmittedRef.current = null
      stopGlide()
      teardownRef.current?.()
      teardownRef.current = null
      emitGain('full')
      if (wasScrubbing) {
        setScrubbing(false)
        latest.current.onScrubChange?.(false)
      }
    },
    [emitGain, stopGlide],
  )

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (disabled) return
      // jsdom and some synthetic dispatchers omit isPrimary/button; only
      // reject pointers that explicitly declare themselves secondary.
      if (event.isPrimary === false) return
      if (typeof event.button === 'number' && event.button !== 0) return
      if (sessionRef.current) return
      // Any press arrests a coasting list, the way a native scroller does.
      stopGlide()
      const origin = event.target as HTMLElement | null
      if (origin?.closest?.(INTERACTIVE_SELECTOR)) return
      // Radix must not see this pointerdown: stopping propagation during the
      // capture phase prevents its bubble handler on the slider root.
      event.stopPropagation()
      releaseImplicitCapture(event.target, event.pointerId)
      const host = event.currentTarget
      const pointerType: 'touch' | 'mouse' =
        event.pointerType === 'touch' || event.pointerType === 'pen'
          ? 'touch'
          : 'mouse'
      if (pointerType === 'mouse') {
        // Keep text from being selected and keep keyboard continuity on the
        // thumb, mirroring what Radix does on its own pointerdown.
        event.preventDefault()
        host.querySelector<HTMLElement>(THUMB_SELECTOR)?.focus({
          preventScroll: true,
        })
      }
      const session = createScrubSession({
        pointerType,
        startValue: valueRef.current,
        startX: event.clientX,
        startY: event.clientY,
        min,
        max,
        step,
        neutral,
        track: readTrackGeometry(host),
      })
      sessionRef.current = session
      pointerIdRef.current = event.pointerId

      // The rest of the gesture is tracked on the document. Pointer capture
      // and hit-testing both move the event target around mid-gesture (the
      // thumb, the track, a neighbouring row), and the browser can revoke an
      // implicit capture when it decides to pan. A document listener sees
      // every move regardless, and the model only needs clientX/clientY.
      // Vertical intent is forwarded to the surrounding list by hand. The row
      // must own the whole touch gesture (`touch-action: none`) or the browser
      // steals it for a pan the moment the finger drifts vertically, which is
      // exactly the movement the precision gain bands are made of. Forwarding
      // keeps the list scrollable from anywhere on the row.
      let scrollTarget: HTMLElement | null = null
      let scrollStartTop = 0
      let scrollStartY = 0
      let lastScrollY = 0
      let lastScrollAt = 0
      let scrollVelocity = 0

      const onDocMove = (native: PointerEvent) => {
        const active = sessionRef.current
        if (!active || native.pointerId !== pointerIdRef.current) return
        // A mouse-up delivered outside the document (browser chrome, another
        // window) never reaches these listeners. The next move without a held
        // button is the signal that the gesture is already over.
        if (pointerType === 'mouse' && native.buttons === 0) {
          onDocEnd(native)
          return
        }
        if (scrollTarget) {
          const now = native.timeStamp || Date.now()
          const dt = now - lastScrollAt
          if (dt > 0) {
            scrollVelocity = (native.clientY - lastScrollY) / dt
            lastScrollY = native.clientY
            lastScrollAt = now
          }
          scrollTarget.scrollTop =
            scrollStartTop - (native.clientY - scrollStartY)
          return
        }
        const wasLocked = active.phase === 'locked'
        const result = active.move(native.clientX, native.clientY, {
          shift: native.shiftKey,
        })
        if (result.phase === 'abandoned') {
          const scroller =
            pointerType === 'touch' ? findScrollableAncestor(host) : null
          if (!scroller) {
            finish(false)
            return
          }
          scrollTarget = scroller
          scrollStartTop = scroller.scrollTop
          scrollStartY = native.clientY
          lastScrollY = native.clientY
          lastScrollAt = native.timeStamp || Date.now()
          scrollVelocity = 0
          return
        }
        if (result.phase !== 'locked') return
        if (!wasLocked) {
          setScrubbing(true)
          latest.current.onScrubChange?.(true)
        }
        emitGain(result.gain)
        emitValue(result.value)
      }

      const glide = (scroller: HTMLElement, velocity: number) => {
        const view = host.ownerDocument.defaultView
        if (!view?.requestAnimationFrame) return
        if (Math.abs(velocity) < SCROLL_MOMENTUM_MIN_VELOCITY) return
        let v = velocity
        let last = view.performance.now()
        // The frame handle lives in a ref so a new press, a new flick, or an
        // unmount can arrest the glide. A scroll view that keeps coasting
        // under a finger is the tell of a hand-rolled scroller.
        const advance = (now: number) => {
          glideFrameRef.current = null
          const elapsed = now - last
          last = now
          scroller.scrollTop -= v * elapsed
          v *= SCROLL_MOMENTUM_DECAY ** (elapsed / 16.67)
          if (Math.abs(v) < SCROLL_MOMENTUM_MIN_VELOCITY) return
          glideFrameRef.current = view.requestAnimationFrame(advance)
        }
        glideFrameRef.current = view.requestAnimationFrame(advance)
      }

      const onDocEnd = (native: PointerEvent) => {
        const active = sessionRef.current
        if (!active || native.pointerId !== pointerIdRef.current) return
        if (scrollTarget) {
          const scroller = scrollTarget
          scrollTarget = null
          if (native.type !== 'pointercancel') {
            glide(scroller, scrollVelocity)
          }
          finish(false)
          return
        }
        const wasLocked = active.phase === 'locked'
        if (native.type === 'pointercancel') {
          active.cancel()
          finish(wasLocked)
          return
        }
        const result = active.end(native.clientX, native.clientY)
        if (result.tapped || result.scrubbed) {
          emitValue(result.value)
        }
        finish(wasLocked)
      }

      const doc = host.ownerDocument
      doc.addEventListener('pointermove', onDocMove, true)
      doc.addEventListener('pointerup', onDocEnd, true)
      doc.addEventListener('pointercancel', onDocEnd, true)
      teardownRef.current = () => {
        doc.removeEventListener('pointermove', onDocMove, true)
        doc.removeEventListener('pointerup', onDocEnd, true)
        doc.removeEventListener('pointercancel', onDocEnd, true)
        try {
          if (host.hasPointerCapture?.(event.pointerId)) {
            host.releasePointerCapture?.(event.pointerId)
          }
        } catch {
          // Best effort; the session state is authoritative.
        }
      }

      if (session.phase === 'locked') {
        // Mouse pointers have no implicit capture: without this a drag that
        // leaves the window stops reporting moves.
        try {
          host.setPointerCapture?.(event.pointerId)
        } catch {
          // Synthetic pointers can lack an active pointer; the document
          // listeners remain authoritative.
        }
        setScrubbing(true)
        latest.current.onScrubChange?.(true)
        emitValue(session.value)
      }
    },
    [disabled, emitGain, emitValue, finish, max, min, neutral, step, stopGlide],
  )

  // Unmounting mid-gesture must close the lifecycle, not just drop the
  // listeners: a stranded `onScrubChange(true)` leaves the mobile Adjust list
  // faded to zero and non-interactive with the HUD pinned over the photo.
  const scrubbingRef = useRef(false)
  scrubbingRef.current = scrubbing
  const finishRef = useRef(finish)
  finishRef.current = finish
  useEffect(
    () => () => {
      stopGlide()
      finishRef.current(scrubbingRef.current)
    },
    [stopGlide],
  )

  const onDoubleClick = useCallback(() => {
    if (disabled) return
    latest.current.onReset?.()
  }, [disabled])

  const ref = useCallback((element: HTMLElement | null) => {
    hostRef.current = element
  }, [])

  const bind = useMemo<SliderScrubBind>(
    () => ({
      ref,
      onPointerDownCapture,
      onDoubleClick,
    }),
    [onDoubleClick, onPointerDownCapture, ref],
  )

  return { scrubbing, gain, bind }
}
