import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import type { TransformState } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import type { TransformEvent } from './transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  isNeutralTransformIntent,
  reduceTransformState,
} from './transform-state'

const SOURCE = 'session-a'
const OTHER_SOURCE = 'session-b'
const FRAME = { width: 600, height: 400 }

const ROTATED: ExportGeometry = {
  matrix: [
    Math.cos(0.05),
    -Math.sin(0.05),
    0,
    Math.sin(0.05),
    Math.cos(0.05),
    0,
    0,
    0,
    1,
  ],
  constrainCrop: true,
}
const ROTATED_FURTHER: ExportGeometry = {
  matrix: [
    Math.cos(0.1),
    -Math.sin(0.1),
    0,
    Math.sin(0.1),
    Math.cos(0.1),
    0,
    0,
    0,
    1,
  ],
  constrainCrop: true,
}
// The projective horizon crosses the unit square, so the export engine
// refuses to plan it whatever the frame size.
const FOLDED: ExportGeometry = {
  matrix: [1, 0, 0, 0, 1, 0, 2, 0, -1],
  constrainCrop: true,
}

function run(state: TransformState, ...events: TransformEvent[]) {
  return events.reduce(reduceTransformState, state)
}

const rotate = (degrees: number): TransformEvent => ({
  type: 'edit',
  sourceId: SOURCE,
  intent: {
    manual: {
      vertical: 0,
      horizontal: 0,
      rotate: degrees,
      aspect: 0,
      scale: 100,
      offsetX: 0,
      offsetY: 0,
    },
  },
})
const capture = (captureKey: string, sourceId = SOURCE): TransformEvent => ({
  type: 'capture',
  sourceId,
  captureKey,
})
const request = (
  captureKey: string,
  requestId: number,
  geometry: ExportGeometry = ROTATED,
  sourceId = SOURCE,
): TransformEvent => ({
  type: 'request',
  sourceId,
  captureKey,
  requestId,
  geometry,
})
const rendered = (
  captureKey: string,
  requestId: number,
  geometry: ExportGeometry = ROTATED,
  sourceId = SOURCE,
): TransformEvent => ({
  type: 'rendered',
  sourceId,
  captureKey,
  requestId,
  geometry,
  frame: FRAME,
})

/** A Transform answered and accepted on capture `k1` by request 1. */
function accepted() {
  return run(
    createTransformState(SOURCE),
    rotate(3),
    capture('k1'),
    request('k1', 1),
    rendered('k1', 1),
  )
}

describe('createTransformState', () => {
  it('starts neutral for its source with nothing captured or answered', () => {
    const state = createTransformState(SOURCE)

    expect(state).toEqual({
      sourceId: SOURCE,
      intent: {
        upright: 'off',
        manual: {
          vertical: 0,
          horizontal: 0,
          rotate: 0,
          aspect: 0,
          scale: 100,
          offsetX: 0,
          offsetY: 0,
        },
        constrainCrop: true,
      },
      capture: null,
      issuedRequests: 0,
      request: null,
      accepted: null,
    })
    expect(isNeutralTransformIntent(state.intent)).toBe(true)
    expect(deriveTransformStatus(state)).toBe('neutral')
    expect(heldTransformGeometry(state)).toBeNull()
  })

  it('never shares the neutral manual values between states', () => {
    const first = createTransformState(SOURCE)
    const second = createTransformState(OTHER_SOURCE)

    expect(first.intent.manual).not.toBe(second.intent.manual)
  })
})

describe('isNeutralTransformIntent', () => {
  const neutral = createTransformState(SOURCE).intent

  it.each([
    ['the neutral intent', neutral, true],
    ['an unconstrained crop alone', { ...neutral, constrainCrop: false }, true],
    ['an Upright mode', { ...neutral, upright: 'auto' as const }, false],
    [
      'a manual rotation',
      { ...neutral, manual: { ...neutral.manual, rotate: 1 } },
      false,
    ],
    [
      'a manual scale',
      { ...neutral, manual: { ...neutral.manual, scale: 90 } },
      false,
    ],
  ])('reads %s as neutral: %s', (_label, intent, expected) => {
    expect(isNeutralTransformIntent(intent)).toBe(expected)
  })
})

describe('reduceTransformState', () => {
  it('accepts a render that answers the newest request on the current capture', () => {
    const state = accepted()

    expect(deriveTransformStatus(state)).toBe('accepted')
    expect(state.accepted).toEqual({
      captureKey: 'k1',
      requestId: 1,
      issued: 1,
      geometry: ROTATED,
    })
    expect(heldTransformGeometry(state)).toEqual(ROTATED)
  })

  it('keeps the requested geometry apart from the rendered one', () => {
    const asked = run(
      createTransformState(SOURCE),
      rotate(3),
      capture('k1'),
      request('k1', 1),
    )

    expect(asked.request?.geometry).toEqual(ROTATED)
    expect(asked.accepted).toBeNull()
    expect(deriveTransformStatus(asked)).toBe('pending')

    // A newer ask leaves the earlier answer as the held geometry, but that
    // answer no longer stands for what the controls ask.
    const moved = run(accepted(), rotate(6), request('k1', 2, ROTATED_FURTHER))

    expect(moved.request?.geometry).toEqual(ROTATED_FURTHER)
    expect(moved.accepted?.geometry).toEqual(ROTATED)
    expect(deriveTransformStatus(moved)).toBe('pending')
    expect(heldTransformGeometry(moved)).toEqual(ROTATED)
  })

  // Every row starts from a pending request 2 on capture k1 of SOURCE, with
  // request 1's answer accepted, and must leave that acceptance untouched.
  const pending = () =>
    run(accepted(), rotate(6), request('k1', 2, ROTATED_FURTHER))

  it.each<[string, TransformEvent]>([
    ['another source', rendered('k1', 2, ROTATED_FURTHER, OTHER_SOURCE)],
    ['another capture', rendered('k0', 2, ROTATED_FURTHER)],
    ['an older request', rendered('k1', 1, ROTATED)],
    ['a request never posted', rendered('k1', 3, ROTATED_FURTHER)],
    ['another geometry for the newest request', rendered('k1', 2, ROTATED)],
  ])('refuses an acknowledgement for %s', (_label, event) => {
    const before = pending()
    const after = reduceTransformState(before, event)

    expect(after).toBe(before)
    expect(after.accepted).toEqual({
      captureKey: 'k1',
      requestId: 1,
      issued: 1,
      geometry: ROTATED,
    })
    expect(deriveTransformStatus(after)).toBe('pending')
  })

  it.each<[string, TransformEvent]>([
    [
      'another source',
      {
        type: 'render-failed',
        sourceId: OTHER_SOURCE,
        captureKey: 'k1',
        requestId: 2,
        failure: 'transform',
      },
    ],
    [
      'an older request',
      {
        type: 'render-failed',
        sourceId: SOURCE,
        captureKey: 'k1',
        requestId: 1,
        failure: 'transform',
      },
    ],
    [
      'another capture',
      {
        type: 'capture-failed',
        sourceId: SOURCE,
        captureKey: 'k0',
      },
    ],
    ['another source capturing', capture('k2', OTHER_SOURCE)],
    ['another source requesting', request('k1', 3, ROTATED, OTHER_SOURCE)],
    ['a request on another capture', request('k0', 3)],
    ['a request older than the newest', request('k1', 2)],
    [
      'an edit from another source',
      { type: 'edit', sourceId: OTHER_SOURCE, intent: { upright: 'full' } },
    ],
    ['a reset from another source', { type: 'reset', sourceId: OTHER_SOURCE }],
  ])('ignores %s', (_label, event) => {
    const before = pending()

    expect(reduceTransformState(before, event)).toBe(before)
  })

  describe('failed newest acknowledgement', () => {
    it.each([
      ['a refused geometry', 'transform', 'invalid'],
      ['a frame that could not be rendered', 'processing', 'unavailable'],
    ] as const)(
      'reports %s and keeps the last valid geometry held',
      (_label, failure, status) => {
        const state = run(accepted(), rotate(6), request('k1', 2), {
          type: 'render-failed',
          sourceId: SOURCE,
          captureKey: 'k1',
          requestId: 2,
          failure,
        })

        expect(deriveTransformStatus(state)).toBe(status)
        expect(state.accepted?.requestId).toBe(1)
        expect(heldTransformGeometry(state)).toEqual(ROTATED)
      },
    )

    it('reports a geometry the export engine refuses to plan as invalid', () => {
      const state = run(
        accepted(),
        rotate(6),
        request('k1', 2, FOLDED),
        rendered('k1', 2, FOLDED),
      )

      expect(deriveTransformStatus(state)).toBe('invalid')
      expect(state.accepted?.requestId).toBe(1)
    })

    it('lets a newer request retire the failure it raised', () => {
      const state = run(
        accepted(),
        rotate(6),
        request('k1', 2),
        {
          type: 'render-failed',
          sourceId: SOURCE,
          captureKey: 'k1',
          requestId: 2,
          failure: 'transform',
        },
        rotate(9),
        request('k1', 3, ROTATED_FURTHER),
      )

      expect(deriveTransformStatus(state)).toBe('pending')

      const answered = run(state, rendered('k1', 3, ROTATED_FURTHER))
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(heldTransformGeometry(answered)).toEqual(ROTATED_FURTHER)
    })
  })

  describe('capture fence', () => {
    it('makes an accepted answer pending again on a new capture', () => {
      const state = run(accepted(), capture('k2'))

      expect(state.request).toBeNull()
      expect(deriveTransformStatus(state)).toBe('pending')
      expect(heldTransformGeometry(state)).toEqual(ROTATED)

      // A late answer from the replaced capture commits nothing.
      expect(reduceTransformState(state, rendered('k1', 1))).toBe(state)

      const answered = run(state, request('k2', 2), rendered('k2', 2))
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(answered.accepted?.captureKey).toBe('k2')
    })

    it('keeps the same capture idempotent', () => {
      const state = accepted()

      expect(reduceTransformState(state, capture('k1'))).toBe(state)
    })

    it('reports a failed capture as unavailable until a new capture starts', () => {
      const failed = run(accepted(), capture('k2'), {
        type: 'capture-failed',
        sourceId: SOURCE,
        captureKey: 'k2',
      })

      expect(deriveTransformStatus(failed)).toBe('unavailable')
      expect(heldTransformGeometry(failed)).toEqual(ROTATED)
      // Nothing can be asked of a frame that was never captured.
      expect(reduceTransformState(failed, request('k2', 2))).toBe(failed)

      const retried = run(failed, capture('k2'))
      expect(deriveTransformStatus(retried)).toBe('pending')
    })
  })

  describe('neutral reset', () => {
    it.each<[string, TransformEvent]>([
      ['reset', { type: 'reset', sourceId: SOURCE }],
      ['an edit back to neutral', rotate(0)],
    ])('clears the held geometry at once on %s', (_label, event) => {
      const state = reduceTransformState(accepted(), event)

      expect(isNeutralTransformIntent(state.intent)).toBe(true)
      expect(deriveTransformStatus(state)).toBe('neutral')
      expect(heldTransformGeometry(state)).toBeNull()
      expect(state.accepted).toBeNull()
      expect(state.request).toBeNull()
      // The frame stays captured; a neutral Transform needs no render.
      expect(state.capture).toEqual({ key: 'k1', failed: false })
    })

    it('retires the failure the reset geometry raised', () => {
      const state = run(
        accepted(),
        rotate(6),
        request('k1', 2),
        {
          type: 'render-failed',
          sourceId: SOURCE,
          captureKey: 'k1',
          requestId: 2,
          failure: 'transform',
        },
        { type: 'reset', sourceId: SOURCE },
      )

      expect(deriveTransformStatus(state)).toBe('neutral')
    })

    it('commits no geometry for a neutral render', () => {
      const state = run(
        createTransformState(SOURCE),
        capture('k1'),
        request('k1', 1),
        rendered('k1', 1),
      )

      expect(state.accepted).toBeNull()
      expect(heldTransformGeometry(state)).toBeNull()
      expect(deriveTransformStatus(state)).toBe('neutral')
    })

    it('restores the default crop mode', () => {
      const state = run(
        createTransformState(SOURCE),
        { type: 'edit', sourceId: SOURCE, intent: { constrainCrop: false } },
        { type: 'reset', sourceId: SOURCE },
      )

      expect(state.intent.constrainCrop).toBe(true)
    })
  })

  describe('source replacement', () => {
    it('gives a replacing source a neutral state of its own', () => {
      const replaced = createTransformState(OTHER_SOURCE)

      expect(replaced.sourceId).toBe(OTHER_SOURCE)
      expect(deriveTransformStatus(replaced)).toBe('neutral')
    })

    it.each<[string, TransformEvent]>([
      ['capture', capture('k1')],
      ['request', request('k1', 1)],
      ['acknowledgement', rendered('k1', 1)],
      ['edit', rotate(3)],
    ])("ignores the replaced source's late %s", (_label, event) => {
      const replaced = createTransformState(OTHER_SOURCE)

      expect(reduceTransformState(replaced, event)).toBe(replaced)
    })
  })

  it('returns the same state for a repeated acknowledgement', () => {
    const state = accepted()

    expect(reduceTransformState(state, rendered('k1', 1))).toBe(state)
  })

  it('returns the same state for a reset of a neutral Transform', () => {
    const state = run(createTransformState(SOURCE), capture('k1'))

    expect(
      reduceTransformState(state, { type: 'reset', sourceId: SOURCE }),
    ).toBe(state)
  })

  it('returns the same state for an edit that changes nothing', () => {
    const state = accepted()

    expect(reduceTransformState(state, rotate(3))).toBe(state)
  })

  it('withdraws the newest request when the intent moves on', () => {
    const state = run(accepted(), {
      type: 'edit',
      sourceId: SOURCE,
      intent: { constrainCrop: false },
    })

    expect(state.request).toBeNull()
    expect(deriveTransformStatus(state)).toBe('pending')
    // The answer to the withdrawn request cannot be accepted any more.
    expect(reduceTransformState(state, rendered('k1', 1))).toBe(state)
  })

  describe('request fence across a withdrawn request', () => {
    // Request ids are numbered by the client that posts them, and a new
    // client starts its numbering again, so an id alone does not name a
    // request once the one it was compared with is withdrawn.
    it('does not take an earlier acceptance for a new request reusing its id', () => {
      const state = run(
        accepted(),
        rotate(6),
        request('k1', 1, ROTATED_FURTHER),
      )

      expect(deriveTransformStatus(state)).toBe('pending')
      expect(heldTransformGeometry(state)).toEqual(ROTATED)

      const answered = run(state, rendered('k1', 1, ROTATED_FURTHER))
      expect(answered).not.toBe(state)
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(heldTransformGeometry(answered)).toEqual(ROTATED_FURTHER)
    })

    it('does not take an earlier acceptance for lower ids after a capture round trip', () => {
      const answeredThird = run(
        createTransformState(SOURCE),
        rotate(3),
        capture('k1'),
        request('k1', 3),
        rendered('k1', 3),
      )
      expect(deriveTransformStatus(answeredThird)).toBe('accepted')

      // Back on capture k1, a client numbering from scratch asks 2, then 3.
      const asked = run(
        answeredThird,
        capture('k2'),
        capture('k1'),
        rotate(6),
        request('k1', 2, ROTATED_FURTHER),
      )
      expect(deriveTransformStatus(asked)).toBe('pending')

      const state = run(asked, rotate(9), request('k1', 3, ROTATED_FURTHER))
      expect(deriveTransformStatus(state)).toBe('pending')
      expect(heldTransformGeometry(state)).toEqual(ROTATED)
      // The answer to the replaced request 3 commits nothing.
      expect(reduceTransformState(state, rendered('k1', 3))).toBe(state)

      const answered = run(state, rendered('k1', 3, ROTATED_FURTHER))
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(heldTransformGeometry(answered)).toEqual(ROTATED_FURTHER)
    })
  })

  it('copies the geometry it stores', () => {
    const matrix = [...ROTATED.matrix]
    const state = run(
      createTransformState(SOURCE),
      rotate(3),
      capture('k1'),
      request('k1', 1, { matrix, constrainCrop: true }),
      rendered('k1', 1, { matrix, constrainCrop: true }),
    )
    matrix[0] = 0

    expect(heldTransformGeometry(state)).toEqual(ROTATED)
  })

  describe('complete state contract', () => {
    it('refuses a pending request without a capture', () => {
      const state = createTransformState(SOURCE)
      const withRequest = reduceTransformState(state, request('k1', 1))

      expect(withRequest).toBe(state)
      expect(state.request).toBeNull()
    })

    it('refuses acknowledgement without a pending request', () => {
      const state = run(createTransformState(SOURCE), capture('k1'))
      const withAck = reduceTransformState(state, rendered('k1', 1))

      expect(withAck).toBe(state)
      expect(state.accepted).toBeNull()
    })

    it('refuses acknowledgement for a neutral intent', () => {
      const state = run(
        createTransformState(SOURCE),
        capture('k1'),
        request('k1', 1),
      )

      expect(isNeutralTransformIntent(state.intent)).toBe(true)
      const withAck = reduceTransformState(state, rendered('k1', 1))

      expect(withAck).toBe(state)
      expect(state.accepted).toBeNull()
    })
  })
})
