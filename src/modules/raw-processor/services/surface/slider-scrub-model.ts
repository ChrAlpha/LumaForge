/**
 * Pointer scrub model shared by every Adjust slider row on /raw.
 *
 * The Radix Slider stays the visual and keyboard layer; this model owns
 * what happens between pointerdown and pointerup so desktop and mobile
 * share one interaction contract:
 *
 * - touch/pen: direction lock (vertical hands the gesture back to the list
 *   scroll), absolute jump on lock, then incremental deltas whose gain
 *   drops as the finger moves away from the track (iOS scrubber idiom);
 * - mouse: immediate absolute jump, Shift for one-tenth gain;
 * - both: sticky detents (neutral by default) that park a value crossing
 *   them, step quantisation, clamping to the field domain.
 *
 * Pure and DOM-free so it can be unit tested exhaustively; `useSliderScrub`
 * wires it to pointer events and pointer capture.
 */

export type ScrubPointerType = 'touch' | 'mouse'
export type ScrubGainBand = 'full' | 'half' | 'quarter' | 'fine'
export type ScrubPhase = 'pending' | 'locked' | 'abandoned' | 'ended'

export interface ScrubTrackGeometry {
  /** Track left edge in the same coordinate space as pointer clientX. */
  left: number
  /** Track width in px. `<= 0` means geometry is unavailable. */
  width: number
  /** Vertical centre of the track, used for the touch gain bands. */
  centerY: number
}

export interface ScrubSessionInput {
  pointerType: ScrubPointerType
  startValue: number
  startX: number
  startY: number
  min: number
  max: number
  step: number
  /**
   * Value the field returns to. Without `detents` it is the one detent,
   * when it lies inside the domain.
   */
  neutral?: number
  /**
   * Values the scrub sticks to. Crossing one parks there until
   * `SCRUB_STICKY_ZERO_RELEASE_PX` of further travel, and a tap within
   * `SCRUB_ZERO_CAPTURE_PX` of its tick lands exactly on it. Defaults to
   * the neutral alone; detents outside the domain are ignored.
   */
  detents?: readonly number[]
  track: ScrubTrackGeometry
}

export interface ScrubMoveModifiers {
  shift?: boolean
}

export interface ScrubMoveResult {
  phase: ScrubPhase
  value: number
  gain: ScrubGainBand
}

export interface ScrubEndResult {
  value: number
  /** True when a touch pointer was released without ever locking. */
  tapped: boolean
  /** True when the gesture produced a locked scrub. */
  scrubbed: boolean
}

/** Travel before a touch gesture commits to horizontal scrub or vertical scroll. */
export const SCRUB_LOCK_SLOP_PX = 6
/** Pointer within this many px of a detent's tick snaps exactly to it. */
export const SCRUB_ZERO_CAPTURE_PX = 4
/** Horizontal travel required to leave a detent once parked on it. */
export const SCRUB_STICKY_ZERO_RELEASE_PX = 10
/** Nominal track width when layout geometry is unavailable (tests, jsdom). */
export const SCRUB_FALLBACK_TRACK_WIDTH = 200
/** Upper bound (px from the track centre) of each touch gain band. */
export const SCRUB_GAIN_BANDS = {
  full: 28,
  half: 84,
  quarter: 150,
} as const
export const SCRUB_GAIN_FACTORS: Record<ScrubGainBand, number> = {
  full: 1,
  half: 0.5,
  quarter: 0.25,
  fine: 0.05,
}
export const SCRUB_MOUSE_FINE_GAIN = 0.1

export function resolveGainBand(distanceFromTrack: number): ScrubGainBand {
  const d = Math.abs(distanceFromTrack)
  if (d <= SCRUB_GAIN_BANDS.full) return 'full'
  if (d <= SCRUB_GAIN_BANDS.half) return 'half'
  if (d <= SCRUB_GAIN_BANDS.quarter) return 'quarter'
  return 'fine'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function quantize(value: number, step: number, min: number, max: number) {
  if (!(step > 0)) return clamp(value, min, max)
  const snapped = Math.round(value / step) * step
  // Trim binary noise (0.1 * 3 → 0.30000000000000004) to the step precision.
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step))))
  const clean = Number(snapped.toFixed(decimals))
  return clamp(clean, min, max)
}

export interface ScrubSession {
  readonly phase: ScrubPhase
  readonly value: number
  readonly gain: ScrubGainBand
  move: (x: number, y: number, modifiers: ScrubMoveModifiers) => ScrubMoveResult
  end: (x: number, y: number) => ScrubEndResult
  cancel: () => void
}

/**
 * The detents a session honours: the given ones inside the domain, or the
 * neutral alone when it lies strictly inside (a neutral on the domain's
 * edge has nothing to cross).
 */
export function resolveScrubDetents(input: {
  min: number
  max: number
  neutral?: number
  detents?: readonly number[]
}): number[] {
  const { min, max } = input
  if (input.detents) {
    return [...new Set(input.detents)]
      .filter((detent) => detent >= min && detent <= max)
      .sort((a, b) => a - b)
  }
  const neutral = input.neutral ?? 0
  return min < neutral && max > neutral ? [neutral] : []
}

export function createScrubSession(input: ScrubSessionInput): ScrubSession {
  const { min, max, step, pointerType } = input
  const span = max - min
  const trackWidth =
    input.track.width > 0 ? input.track.width : SCRUB_FALLBACK_TRACK_WIDTH
  const hasGeometry = input.track.width > 0
  const unitsPerPx = span / trackWidth
  const detents = resolveScrubDetents(input)
  const detentX = (detent: number) =>
    input.track.left + ((detent - min) / span) * trackWidth

  let phase: ScrubPhase = 'pending'
  let continuous = input.startValue
  let value = quantize(input.startValue, step, min, max)
  let gain: ScrubGainBand = 'full'
  let lastX = input.startX
  let parkedAt: number | null = null
  let stickyTravelPx = 0

  const valueAtX = (x: number) => {
    if (!hasGeometry) return continuous
    let captured: number | null = null
    let capturedDistance = Number.POSITIVE_INFINITY
    for (const detent of detents) {
      const distance = Math.abs(x - detentX(detent))
      if (distance <= SCRUB_ZERO_CAPTURE_PX && distance < capturedDistance) {
        captured = detent
        capturedDistance = distance
      }
    }
    if (captured !== null) return captured
    const t = clamp((x - input.track.left) / trackWidth, 0, 1)
    return min + t * span
  }

  /**
   * The first detent a move from `prev` to `next` crosses, nearest `prev`.
   * A move that starts on a detent leaves it freely: parking on the way out
   * would put a dead zone exactly where fine control matters most.
   */
  const firstCrossed = (prev: number, next: number) => {
    let crossed: number | null = null
    for (const detent of detents) {
      if (prev === detent) continue
      if (Math.sign(prev - detent) === Math.sign(next - detent)) continue
      if (
        crossed === null ||
        Math.abs(detent - prev) < Math.abs(crossed - prev)
      ) {
        crossed = detent
      }
    }
    return crossed
  }

  const commit = (next: number) => {
    continuous = clamp(next, min, max)
    value = quantize(continuous, step, min, max)
  }

  const park = (detent: number) => {
    parkedAt = detent
    stickyTravelPx = 0
    commit(detent)
  }

  const lockAt = (x: number) => {
    phase = 'locked'
    commit(valueAtX(x))
    // A detent only arms when a scrub crosses it mid-gesture; a lock that
    // lands on one must still follow the pointer immediately.
    parkedAt = null
    stickyTravelPx = 0
    lastX = x
  }

  const currentGain = (
    y: number,
    modifiers: ScrubMoveModifiers,
  ): { band: ScrubGainBand; factor: number } => {
    if (pointerType === 'mouse') {
      return modifiers.shift
        ? { band: 'fine', factor: SCRUB_MOUSE_FINE_GAIN }
        : { band: 'full', factor: 1 }
    }
    const band = resolveGainBand(y - input.track.centerY)
    return { band, factor: SCRUB_GAIN_FACTORS[band] }
  }

  const integrate = (x: number, y: number, modifiers: ScrubMoveModifiers) => {
    const dxPx = x - lastX
    lastX = x
    const { band, factor } = currentGain(y, modifiers)
    gain = band
    if (dxPx === 0) return

    if (parkedAt !== null) {
      const detent = parkedAt
      stickyTravelPx += dxPx
      if (Math.abs(stickyTravelPx) < SCRUB_STICKY_ZERO_RELEASE_PX) {
        commit(detent)
        return
      }
      parkedAt = null
      const overshoot =
        stickyTravelPx -
        Math.sign(stickyTravelPx) * SCRUB_STICKY_ZERO_RELEASE_PX
      stickyTravelPx = 0
      const next =
        detent +
        Math.sign(overshoot || dxPx) * step +
        overshoot * unitsPerPx * factor
      // Leaving one detent can run straight into the next.
      const crossed = firstCrossed(detent, next)
      if (crossed !== null) park(crossed)
      else commit(next)
      return
    }

    const prev = continuous
    const next = prev + dxPx * unitsPerPx * factor
    const crossed = firstCrossed(prev, next)
    if (crossed !== null) {
      park(crossed)
      return
    }
    commit(next)
  }

  if (pointerType === 'mouse') {
    lockAt(input.startX)
  }

  return {
    get phase() {
      return phase
    },
    get value() {
      return value
    },
    get gain() {
      return gain
    },
    move(x, y, modifiers) {
      if (phase === 'abandoned' || phase === 'ended') {
        return { phase, value, gain }
      }
      if (phase === 'pending') {
        const dx = x - input.startX
        const dy = y - input.startY
        if (Math.hypot(dx, dy) < SCRUB_LOCK_SLOP_PX) {
          return { phase, value, gain }
        }
        if (Math.abs(dy) > Math.abs(dx)) {
          phase = 'abandoned'
          return { phase, value, gain }
        }
        lockAt(x)
        return { phase, value, gain }
      }
      integrate(x, y, modifiers)
      return { phase, value, gain }
    },
    end(x, y) {
      if (phase === 'pending') {
        phase = 'ended'
        if (hasGeometry) {
          commit(valueAtX(x))
        }
        void y
        return { value, tapped: true, scrubbed: false }
      }
      if (phase === 'locked') {
        phase = 'ended'
        return { value, tapped: false, scrubbed: true }
      }
      phase = 'ended'
      return { value, tapped: false, scrubbed: false }
    },
    cancel() {
      phase = 'ended'
    },
  }
}
