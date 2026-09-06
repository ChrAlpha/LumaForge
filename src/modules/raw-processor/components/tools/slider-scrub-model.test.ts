import { describe, expect, it } from 'vitest'

import {
  createScrubSession,
  resolveGainBand,
  SCRUB_GAIN_BANDS,
  SCRUB_LOCK_SLOP_PX,
  SCRUB_STICKY_ZERO_RELEASE_PX,
  SCRUB_ZERO_CAPTURE_PX,
} from './slider-scrub-model'

// A 200px track at x=100..300 mapping [-100, 100] → 1 unit per px.
const TRACK = { left: 100, width: 200, centerY: 50 }
const BASE = { min: -100, max: 100, step: 1, track: TRACK }

function touchSession(
  overrides: Partial<Parameters<typeof createScrubSession>[0]> = {},
) {
  return createScrubSession({
    ...BASE,
    pointerType: 'touch',
    startValue: 0,
    startX: 200,
    startY: 50,
    ...overrides,
  })
}

function mouseSession(
  overrides: Partial<Parameters<typeof createScrubSession>[0]> = {},
) {
  return createScrubSession({
    ...BASE,
    pointerType: 'mouse',
    startValue: 0,
    startX: 200,
    startY: 50,
    ...overrides,
  })
}

describe('resolveGainBand', () => {
  it('maps vertical distance from the track to the documented bands', () => {
    expect(resolveGainBand(0)).toBe('full')
    expect(resolveGainBand(SCRUB_GAIN_BANDS.full)).toBe('full')
    expect(resolveGainBand(SCRUB_GAIN_BANDS.full + 1)).toBe('half')
    expect(resolveGainBand(SCRUB_GAIN_BANDS.half + 1)).toBe('quarter')
    expect(resolveGainBand(SCRUB_GAIN_BANDS.quarter + 1)).toBe('fine')
  })
})

describe('createScrubSession (touch)', () => {
  it('does not change the value before the lock slop is exceeded', () => {
    const session = touchSession({ startValue: 20 })
    const result = session.move(200 + SCRUB_LOCK_SLOP_PX - 1, 50, {})
    expect(result.phase).toBe('pending')
    expect(result.value).toBe(20)
  })

  it('abandons the gesture when the first movement is mostly vertical', () => {
    const session = touchSession({ startValue: 20 })
    const result = session.move(202, 50 + SCRUB_LOCK_SLOP_PX + 4, {})
    expect(result.phase).toBe('abandoned')
    expect(result.value).toBe(20)
    // Further moves are ignored once abandoned.
    expect(session.move(260, 120, {}).phase).toBe('abandoned')
  })

  it('locks on horizontal travel, jumps to the finger, then integrates deltas', () => {
    const session = touchSession({ startValue: 0 })
    const locked = session.move(210, 50, {})
    expect(locked.phase).toBe('locked')
    // Absolute jump: finger at x=210 on a 200px track → +10.
    expect(locked.value).toBe(10)
    expect(session.move(240, 50, {}).value).toBe(40)
    expect(session.move(230, 50, {}).value).toBe(30)
  })

  it('reduces horizontal gain as the finger moves away from the track', () => {
    const session = touchSession({ startValue: 0 })
    session.move(220, 50, {}) // lock at +20
    // Move to the quarter band: 100px away from the track centre.
    session.move(220, 150, {})
    const result = session.move(260, 150, {})
    // 40px of travel at quarter gain → +10 units.
    expect(result.value).toBe(30)
    expect(result.gain).toBe('quarter')
  })

  it('never jumps when crossing a gain band boundary', () => {
    const session = touchSession({ startValue: 0 })
    session.move(220, 50, {})
    const before = session.move(240, 50, {}).value
    const after = session.move(240, 50 + SCRUB_GAIN_BANDS.full + 1, {})
    expect(after.value).toBe(before)
    expect(after.gain).toBe('half')
  })

  it('parks at zero when crossing neutral and releases after the sticky travel', () => {
    const session = touchSession({ startValue: 0 })
    session.move(215, 50, {}) // +15
    const crossed = session.move(195, 50, {}) // would be -5
    expect(crossed.value).toBe(0)
    const held = session.move(195 - SCRUB_STICKY_ZERO_RELEASE_PX + 2, 50, {})
    expect(held.value).toBe(0)
    const released = session.move(
      195 - SCRUB_STICKY_ZERO_RELEASE_PX - 4,
      50,
      {},
    )
    expect(released.value).toBeLessThan(0)
  })

  it('answers a small drag that starts at neutral (no dead zone at zero)', () => {
    // Press on the thumb of a neutral field, then move a few px in ten
    // sub-pixel steps: the shape a slow finger or a stepped pointer drag
    // produces. Parking here swallowed the whole gesture.
    const session = mouseSession({ startValue: 0, startX: 200 })
    expect(session.value).toBe(0)
    let last = session.value
    for (let i = 1; i <= 10; i += 1) {
      last = session.move(200 + i * 0.27, 50, {}).value
    }
    expect(last).toBeGreaterThan(0)
  })

  it('treats a release without a lock as a tap that sets the value at the tap point', () => {
    const session = touchSession({ startValue: 40 })
    const result = session.end(150, 52)
    expect(result.tapped).toBe(true)
    expect(result.value).toBe(-50)
  })

  it('captures zero when tapping within the zero capture window', () => {
    const session = touchSession({ startValue: 40 })
    const result = session.end(200 + SCRUB_ZERO_CAPTURE_PX - 1, 50)
    expect(result.value).toBe(0)
  })

  it('quantises to the field step and clamps to the domain', () => {
    const session = createScrubSession({
      ...BASE,
      min: -5,
      max: 5,
      step: 0.01,
      pointerType: 'touch',
      startValue: 0,
      startX: 200,
      startY: 50,
    })
    session.move(210, 50, {})
    expect(session.move(400, 50, {}).value).toBe(5)
    const fine = session.move(390, 150, {})
    expect(Number.isInteger(Math.round(fine.value * 100))).toBe(true)
    expect(fine.value).toBeGreaterThanOrEqual(-5)
    expect(fine.value).toBeLessThanOrEqual(5)
  })
})

describe('createScrubSession (mouse)', () => {
  it('locks immediately at the pointer position', () => {
    const session = mouseSession({ startValue: 0, startX: 250 })
    expect(session.phase).toBe('locked')
    expect(session.value).toBe(50)
  })

  it('applies the fine gain while shift is held without jumping', () => {
    const session = mouseSession({ startValue: 0, startX: 200 })
    session.move(220, 50, {})
    const fine = session.move(240, 50, { shift: true })
    // 20px at 0.1 gain → +2.
    expect(fine.value).toBe(22)
    expect(fine.gain).toBe('fine')
    const back = session.move(260, 50, {})
    expect(back.value).toBe(42)
  })

  it('ignores vertical distance for mouse pointers', () => {
    const session = mouseSession({ startValue: 0, startX: 200 })
    const moved = session.move(240, 300, {})
    expect(moved.value).toBe(40)
    expect(moved.gain).toBe('full')
  })

  it('falls back to a nominal track width when geometry is unavailable', () => {
    const session = createScrubSession({
      ...BASE,
      track: { left: 0, width: 0, centerY: 0 },
      pointerType: 'mouse',
      startValue: 10,
      startX: 0,
      startY: 0,
    })
    expect(session.value).toBe(10)
    expect(session.move(20, 0, {}).value).toBeGreaterThan(10)
  })
})

describe('createScrubSession with a non-zero neutral', () => {
  // A 0..100 domain whose rest value is 50: the park, the tap capture window,
  // and the sticky release must all anchor there rather than at 0.
  const UNIPOLAR = { min: 0, max: 100, step: 1, track: TRACK, neutral: 50 }

  it('captures the neutral tick on a tap and parks when crossing it', () => {
    const tap = createScrubSession({
      ...UNIPOLAR,
      pointerType: 'touch',
      startValue: 80,
      startX: 200,
      startY: 50,
    })
    // Track centre is the neutral tick for this domain.
    expect(tap.end(200 + SCRUB_ZERO_CAPTURE_PX - 1, 50).value).toBe(50)

    const drag = createScrubSession({
      ...UNIPOLAR,
      pointerType: 'mouse',
      startValue: 0,
      startX: 220,
      startY: 50,
    })
    expect(drag.value).toBe(60)
    // Crossing back down through 50 parks there instead of at 0.
    expect(drag.move(195, 50, {}).value).toBe(50)
    expect(drag.move(190, 50, {}).value).toBe(50)
  })
})
