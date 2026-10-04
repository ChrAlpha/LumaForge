import { Columns2 } from 'lucide-react'
import { AnimatePresence, m, useReducedMotion } from 'motion/react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useId, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import { useI18n } from '~/lib/i18n'
import { surfaceFade } from '~/lib/spring'

import { TAP_SPRING } from '../../motion'
import { LONG_PRESS_MS, TAP_SLOP_PX } from './useMobilePreviewGestures'

/**
 * Where the lens sits, as CSS variables on the mobile chrome. The values
 * place the visible 32px circle 8px inside the top-right corner of the photo
 * rect the stage layout publishes on the shell, so the lens rides on the
 * photo for portrait images too. Anything that must clear the lens (the
 * floating histogram, the peek pill) reads the same variables. Before the
 * layout has measured, the fallbacks put it under the topbar at the edge.
 */
export const COMPARE_LENS_POSITION = {
  '--raw-compare-lens-top':
    'calc(var(--raw-photo-top, var(--raw-stage-inset-top, 0px)) + 8px)',
  '--raw-compare-lens-right': 'calc(var(--raw-photo-right, 0px) + 8px)',
  '--raw-compare-lens-size': '32px',
} as CSSProperties

/**
 * Width (px) of the photo the lens column takes from a hint beside it: the
 * 8px inset, the 32px circle, the 6px of hit area past it, a 4px gap, and
 * 8px kept clear of the photo's left edge.
 */
const LENS_HINT_SIDE_RESERVE_PX = 58
/** Below this, a hint beside the lens would wrap into a tall sliver. */
const LENS_HINT_MIN_SIDE_WIDTH_PX = 150

export type LensHintPlacement = 'side' | 'below'

/**
 * A hint sits beside the lens while the photo leaves it room to the left,
 * and flips below the lens on a photo too narrow for that. Before the photo
 * is measured it keeps the side.
 */
export function getLensHintPlacement(photoWidth: number): LensHintPlacement {
  if (!(photoWidth > 0)) return 'side'
  return photoWidth - LENS_HINT_SIDE_RESERVE_PX >= LENS_HINT_MIN_SIDE_WIDTH_PX
    ? 'side'
    : 'below'
}

export const LENS_HINT_STORAGE_KEY = 'lumaforge.raw.mobile.lensHintSeen.v1'
const LENS_HINT_MS = 4000
const BLOCKED_HINT_MS = 2000

// Fallback for browsers that refuse storage (private mode): the hint still
// shows at most once per page session.
let lensHintSeenFallback = false

function readLensHintSeen() {
  try {
    return window.localStorage.getItem(LENS_HINT_STORAGE_KEY) === '1'
  } catch {
    return lensHintSeenFallback
  }
}

function markLensHintSeen() {
  lensHintSeenFallback = true
  try {
    window.localStorage.setItem(LENS_HINT_STORAGE_KEY, '1')
  } catch {
    // Storage is best-effort; the session fallback above still holds.
  }
}

function tryCapture(target: Element, pointerId: number) {
  try {
    target.setPointerCapture?.(pointerId)
  } catch {
    // Synthetic pointers can lack an active pointer to capture.
  }
}

function tryRelease(target: Element, pointerId: number) {
  try {
    if (target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture(pointerId)
    }
  } catch {
    // Best-effort; our own press state is authoritative.
  }
}

/**
 * Compare is a lens over the photo, orthogonal to the dock's tools: a tap
 * toggles the RAW / final split, which stays on while tools change, and a
 * hold peeks the unprocessed RAW until release. A hold never toggles.
 */
export function MobileCompareLens(props: {
  splitOn: boolean
  /** A committed Transform cannot be compared; a tap explains why. */
  disabled: boolean
  onToggle: () => void
  onPeekStart: () => void
  onPeekEnd: () => void
  /** Where hints go, from the photo's width (getLensHintPlacement). */
  hintPlacement?: LensHintPlacement
}) {
  const { t } = useI18n()
  const hintBelow = props.hintPlacement === 'below'
  const reduced = useReducedMotion() ?? false
  const descriptionId = useId()
  const [blockedHint, setBlockedHint] = useState(false)
  const [introHint, setIntroHint] = useState(false)
  const press = useRef<{ pointerId: number; x: number; y: number } | null>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const holding = useRef(false)
  // A press that became a hold, slid away, or was cancelled is not a tap.
  const suppressClick = useRef(false)
  const onPeekEndRef = useRef(props.onPeekEnd)

  useEffect(() => {
    onPeekEndRef.current = props.onPeekEnd
  }, [props.onPeekEnd])

  const clearHoldTimer = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  // If the lens leaves mid-hold (a handoff, the RAW cleared), the peek must
  // not outlive the finger that started it.
  useEffect(
    () => () => {
      if (holdTimer.current !== null) clearTimeout(holdTimer.current)
      if (holding.current) {
        holding.current = false
        onPeekEndRef.current()
      }
    },
    [],
  )

  // First image on this device: name both gestures once, then get out of
  // the way after a few seconds or the first touch anywhere.
  useEffect(() => {
    if (readLensHintSeen()) return
    markLensHintSeen()
    setIntroHint(true)
  }, [])

  useEffect(() => {
    if (!introHint) return
    const timer = setTimeout(setIntroHint, LENS_HINT_MS, false)
    const dismiss = () => setIntroHint(false)
    document.addEventListener('pointerdown', dismiss, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', dismiss, true)
    }
  }, [introHint])

  useEffect(() => {
    if (!blockedHint) return
    const timer = setTimeout(setBlockedHint, BLOCKED_HINT_MS, false)
    return () => clearTimeout(timer)
  }, [blockedHint])

  const endPress = (target: Element, pointerId: number) => {
    clearHoldTimer()
    press.current = null
    tryRelease(target, pointerId)
    if (holding.current) {
      holding.current = false
      props.onPeekEnd()
    }
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    suppressClick.current = false
    press.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    }
    // Capture keeps the release on the lens even when the finger drifts off
    // it, so a peek always ends cleanly.
    tryCapture(event.currentTarget, event.pointerId)
    clearHoldTimer()
    if (props.disabled) return
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      if (!press.current) return
      holding.current = true
      suppressClick.current = true
      setIntroHint(false)
      props.onPeekStart()
    }, LONG_PRESS_MS)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId || holding.current)
      return
    if (
      Math.hypot(event.clientX - current.x, event.clientY - current.y) >
      TAP_SLOP_PX
    ) {
      // Slid away before the hold landed: neither a tap nor a peek.
      clearHoldTimer()
      suppressClick.current = true
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (press.current?.pointerId !== event.pointerId) return
    endPress(event.currentTarget, event.pointerId)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (press.current?.pointerId !== event.pointerId) return
    suppressClick.current = true
    endPress(event.currentTarget, event.pointerId)
  }

  const onClick = () => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    setIntroHint(false)
    if (props.disabled) {
      setBlockedHint(true)
      return
    }
    props.onToggle()
  }

  const state = props.disabled ? 'disabled' : props.splitOn ? 'on' : 'off'
  const hint = blockedHint
    ? t('raw.mobile.compare.unavailable')
    : introHint
      ? t('raw.mobile.compare.lensHint')
      : null

  return (
    <m.div
      data-mobile-compare-lens-anchor
      // The 44px hit area is centred on the 32px circle, so it sits 6px
      // outside the published circle position on both axes. It follows the
      // photo rect on the stage's own 240ms curve.
      className="pointer-events-none absolute z-[16] size-11 transition-[top,right] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
      style={{
        top: 'calc(var(--raw-compare-lens-top) - 6px)',
        right: 'calc(var(--raw-compare-lens-right) - 6px)',
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={surfaceFade}
    >
      {/* Live region stays mounted so the blocked reason is announced. A
          hint hangs off the lens's left edge, centred on it, so a wrapped
          hint never pushes the lens; its width is capped by the room the
          photo leaves there. On a photo too narrow for that it drops below
          the lens, right-aligned to the circle, capped by the photo width.
          Either way it stays on the photo. */}
      <div
        role="status"
        aria-live="polite"
        data-mobile-compare-lens-hint-slot={hintBelow ? 'below' : 'side'}
        className={
          hintBelow
            ? 'absolute right-1.5 top-full flex justify-end pt-0.5'
            : 'absolute right-full top-0 flex h-11 items-center pr-1'
        }
      >
        <AnimatePresence mode="wait" initial={false}>
          {hint && (
            <m.span
              key={blockedHint ? 'blocked' : 'intro'}
              data-mobile-compare-lens-hint={blockedHint ? 'blocked' : 'intro'}
              initial={{
                opacity: 0,
                x: reduced || hintBelow ? 0 : 4,
                y: reduced || !hintBelow ? 0 : -4,
              }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{
                opacity: 0,
                x: reduced || hintBelow ? 0 : 4,
                y: reduced || !hintBelow ? 0 : -4,
              }}
              transition={surfaceFade}
              className={clsxm(
                'w-max rounded-lf-pill bg-[oklch(0.1_0.006_255/0.84)] px-2.5 py-1.5 text-right text-[0.7rem] font-semibold leading-snug text-lf-on-photo-ink/92 shadow-[inset_0_0_0_1px_oklch(0.96_0.006_255/0.16)] backdrop-blur-background',
                hintBelow
                  ? 'max-w-[min(232px,calc(var(--raw-photo-width,100vw)-16px))]'
                  : 'max-w-[min(232px,calc(var(--raw-photo-width,100vw)-58px))]',
              )}
            >
              {hint}
            </m.span>
          )}
        </AnimatePresence>
      </div>
      <span id={descriptionId} className="sr-only">
        {props.disabled
          ? t('raw.mobile.compare.unavailable')
          : t('raw.mobile.compare.lensHint')}
      </span>
      <m.button
        type="button"
        data-mobile-compare-lens
        data-state={state}
        aria-label={t('raw.mobile.compare.split')}
        aria-pressed={props.splitOn}
        aria-disabled={props.disabled || undefined}
        aria-describedby={descriptionId}
        whileTap={{ y: 0.5 }}
        transition={TAP_SPRING}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={(event) => {
          // Capture lost without a release (the element moved, the page
          // hid): end the press the same way a cancel does.
          if (press.current?.pointerId !== event.pointerId) return
          suppressClick.current = true
          endPress(event.currentTarget, event.pointerId)
        }}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            suppressClick.current = false
          }
        }}
        onClick={onClick}
        className={clsxm(
          'group pointer-events-auto grid size-11 shrink-0 touch-none select-none place-items-center rounded-full outline-none [-webkit-touch-callout:none]',
          props.disabled && 'cursor-not-allowed',
        )}
      >
        <span
          aria-hidden="true"
          className={clsxm(
            'grid size-[var(--raw-compare-lens-size,32px)] place-items-center rounded-full transition-[background-color,color,box-shadow,opacity] duration-[180ms] ease-out',
            'group-focus-visible:outline-2 group-focus-visible:-outline-offset-1 group-focus-visible:outline-lf-green/80',
            props.splitOn
              ? // Slate icon on the bright lift: the split is on.
                'bg-[oklch(0.96_0.006_255/0.9)] text-lf-surface shadow-[0_1px_6px_oklch(0.04_0.006_255/0.4)]'
              : 'bg-[oklch(0.1_0.006_255/0.72)] text-lf-on-photo-ink shadow-[inset_0_0_0_1px_oklch(0.96_0.006_255/0.2)] backdrop-blur-background',
            !props.disabled &&
              !props.splitOn &&
              'group-hover:shadow-[inset_0_0_0_1px_oklch(0.96_0.006_255/0.36)] group-active:bg-[oklch(0.14_0.006_255/0.8)]',
            props.disabled && 'opacity-40',
          )}
        >
          <Columns2 className="size-4" />
        </span>
      </m.button>
    </m.div>
  )
}
