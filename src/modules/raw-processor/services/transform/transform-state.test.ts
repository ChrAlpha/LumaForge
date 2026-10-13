import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { describe, expect, it } from 'vitest'

import type { TransformState } from '../../model/session'
import { createTransformState } from '../../model/session-factory'
import { createTestSession } from '../../test-support/builders'
import type { TransformEvent } from './transform-state'
import {
  deriveTransformStatus,
  heldTransformGeometry,
  isNeutralTransformIntent,
  reduceTransformState,
  transitionSessionTransform,
} from './transform-state'

const SOURCE = 'session-a'
const OTHER_SOURCE = 'session-b'
const FRAME = { width: 600, height: 400 }

/** A rotation by `radians`, constrained to the crop. */
function rotation(radians: number): ExportGeometry {
  return {
    matrix: [
      Math.cos(radians),
      -Math.sin(radians),
      0,
      Math.sin(radians),
      Math.cos(radians),
      0,
      0,
      0,
      1,
    ],
    constrainCrop: true,
  }
}
// The geometries `rotate(3)`, `rotate(6)` and `rotate(9)` ask for.
const ROTATED = rotation(0.05)
const ROTATED_FURTHER = rotation(0.1)
const ROTATED_MOST = rotation(0.15)
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
// The lifetime of the client the events come from. A client numbers its
// sources and requests from scratch, so two clients post the same local ids.
const CLIENT = 1
const NEXT_CLIENT = 2

type From = { sourceId?: string; clientEpoch?: number }

const capture = (
  captureKey: string,
  { sourceId = SOURCE, clientEpoch = CLIENT }: From = {},
): TransformEvent => ({
  type: 'capture',
  sourceId,
  captureKey,
  clientEpoch,
})
const captureFailed = (
  captureKey: string,
  { sourceId = SOURCE, clientEpoch = CLIENT }: From = {},
): TransformEvent => ({
  type: 'capture-failed',
  sourceId,
  captureKey,
  clientEpoch,
})
const request = (
  captureKey: string,
  requestId: number,
  geometry: ExportGeometry = ROTATED,
  { sourceId = SOURCE, clientEpoch = CLIENT }: From = {},
): TransformEvent => ({
  type: 'request',
  sourceId,
  captureKey,
  clientEpoch,
  requestId,
  geometry,
})
const rendered = (
  captureKey: string,
  requestId: number,
  geometry: ExportGeometry = ROTATED,
  { sourceId = SOURCE, clientEpoch = CLIENT }: From = {},
): TransformEvent => ({
  type: 'rendered',
  sourceId,
  captureKey,
  clientEpoch,
  requestId,
  geometry,
  frame: FRAME,
})
const renderFailed = (
  captureKey: string,
  requestId: number,
  failure: 'transform' | 'processing' = 'transform',
  { sourceId = SOURCE, clientEpoch = CLIENT }: From = {},
): TransformEvent => ({
  type: 'render-failed',
  sourceId,
  captureKey,
  clientEpoch,
  requestId,
  failure,
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
      clientEpoch: CLIENT,
      requestId: 1,
      issued: 1,
      geometry: ROTATED,
    })
    expect(heldTransformGeometry(state)).toEqual(ROTATED)
  })

  // Every row starts from a pending request 2 on capture k1 of SOURCE, with
  // request 1's answer accepted, and must leave that acceptance untouched.
  const pending = () =>
    run(accepted(), rotate(6), request('k1', 2, ROTATED_FURTHER))

  it.each<[string, TransformEvent]>([
    [
      'another source',
      rendered('k1', 2, ROTATED_FURTHER, { sourceId: OTHER_SOURCE }),
    ],
    ['another capture', rendered('k0', 2, ROTATED_FURTHER)],
    [
      'another client lifetime',
      rendered('k1', 2, ROTATED_FURTHER, { clientEpoch: NEXT_CLIENT }),
    ],
    ['an older request', rendered('k1', 1, ROTATED)],
    ['a request never posted', rendered('k1', 3, ROTATED_FURTHER)],
    ['another geometry for the newest request', rendered('k1', 2, ROTATED)],
  ])('refuses an acknowledgement for %s', (_label, event) => {
    const before = pending()
    const after = reduceTransformState(before, event)

    expect(after).toBe(before)
    expect(after.accepted).toEqual({
      captureKey: 'k1',
      clientEpoch: CLIENT,
      requestId: 1,
      issued: 1,
      geometry: ROTATED,
    })
    expect(deriveTransformStatus(after)).toBe('pending')
  })

  it.each<[string, TransformEvent]>([
    [
      'another source',
      renderFailed('k1', 2, 'transform', { sourceId: OTHER_SOURCE }),
    ],
    ['an older request', renderFailed('k1', 1)],
    [
      'another client lifetime failing',
      renderFailed('k1', 2, 'transform', { clientEpoch: NEXT_CLIENT }),
    ],
    ['another capture', captureFailed('k0')],
    [
      'another client lifetime failing the capture',
      captureFailed('k1', { clientEpoch: NEXT_CLIENT }),
    ],
    ['another source capturing', capture('k2', { sourceId: OTHER_SOURCE })],
    [
      'another source requesting',
      request('k1', 3, ROTATED_MOST, { sourceId: OTHER_SOURCE }),
    ],
    [
      'another client lifetime requesting',
      request('k1', 3, ROTATED_MOST, { clientEpoch: NEXT_CLIENT }),
    ],
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
        const state = run(
          accepted(),
          rotate(6),
          request('k1', 2, ROTATED_FURTHER),
          renderFailed('k1', 2, failure),
        )

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
        request('k1', 2, ROTATED_FURTHER),
        renderFailed('k1', 2),
        rotate(9),
        request('k1', 3, ROTATED_MOST),
      )

      expect(deriveTransformStatus(state)).toBe('pending')

      const answered = run(state, rendered('k1', 3, ROTATED_MOST))
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(heldTransformGeometry(answered)).toEqual(ROTATED_MOST)
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

    it('reports a failed capture as unavailable until a new capture starts', () => {
      const failed = run(accepted(), capture('k2'), captureFailed('k2'))

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
      expect(state.capture).toEqual({
        key: 'k1',
        clientEpoch: CLIENT,
        failed: false,
      })
    })

    it('retires the failure the reset geometry raised', () => {
      const state = run(
        accepted(),
        rotate(6),
        request('k1', 2, ROTATED_FURTHER),
        renderFailed('k1', 2),
        { type: 'reset', sourceId: SOURCE },
      )

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

  it.each<[string, () => TransformState, TransformEvent]>([
    ['the same capture', accepted, capture('k1')],
    ['a repeated acknowledgement', accepted, rendered('k1', 1)],
    ['an edit that changes nothing', accepted, rotate(3)],
    [
      'a reset of a neutral Transform',
      () => run(createTransformState(SOURCE), capture('k1')),
      { type: 'reset', sourceId: SOURCE },
    ],
    [
      'a request without a capture',
      () => createTransformState(SOURCE),
      request('k1', 1),
    ],
    [
      'an acknowledgement without a pending request',
      () => run(createTransformState(SOURCE), capture('k1')),
      rendered('k1', 1),
    ],
    [
      'an acknowledgement for a neutral intent',
      () => run(createTransformState(SOURCE), capture('k1'), request('k1', 1)),
      rendered('k1', 1),
    ],
  ])('returns the state it was given for %s', (_label, from, event) => {
    const state = from()

    expect(reduceTransformState(state, event)).toBe(state)
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
    // A request id alone does not name a request once the one it was
    // compared with is withdrawn; each taken request also gets an `issued`
    // number no other request of this source holds.
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
      const next = { clientEpoch: NEXT_CLIENT }
      const asked = run(
        answeredThird,
        capture('k2'),
        capture('k1', next),
        rotate(6),
        request('k1', 2, ROTATED_FURTHER, next),
      )
      expect(deriveTransformStatus(asked)).toBe('pending')

      const state = run(asked, rotate(9), request('k1', 3, ROTATED_MOST, next))
      expect(deriveTransformStatus(state)).toBe('pending')
      expect(heldTransformGeometry(state)).toEqual(ROTATED)
      // The answers to the earlier client's request 3 and to the withdrawn
      // request 2 commit nothing.
      expect(reduceTransformState(state, rendered('k1', 3))).toBe(state)
      expect(
        reduceTransformState(state, rendered('k1', 3, ROTATED, next)),
      ).toBe(state)
      expect(
        reduceTransformState(state, rendered('k1', 2, ROTATED_FURTHER, next)),
      ).toBe(state)

      const answered = run(state, rendered('k1', 3, ROTATED_MOST, next))
      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(heldTransformGeometry(answered)).toEqual(ROTATED_MOST)
    })
  })

  describe('client lifetime fence', () => {
    // Two clients number their requests alike: each event below repeats a
    // source, capture, request and geometry of the other client, and only
    // the client lifetime tells them apart.
    const old = { clientEpoch: CLIENT }
    const next = { clientEpoch: NEXT_CLIENT }

    /** Client 1 answered request 1 on k1; client 2 now holds k1. */
    const handedOver = () => run(accepted(), capture('k1', next))

    it('starts a new capture when another client holds the same frame', () => {
      const before = accepted()
      const state = handedOver()

      expect(state).not.toBe(before)
      expect(state.capture).toEqual({
        key: 'k1',
        clientEpoch: NEXT_CLIENT,
        failed: false,
      })
      expect(state.request).toBeNull()
      expect(deriveTransformStatus(state)).toBe('pending')
      expect(heldTransformGeometry(state)).toEqual(ROTATED)
      expect(reduceTransformState(state, capture('k1', next))).toBe(state)
    })

    it('takes no request from the earlier client on the frame it handed over', () => {
      const before = handedOver()

      expect(reduceTransformState(before, request('k1', 1, ROTATED, old))).toBe(
        before,
      )
    })

    it.each<[string, TransformEvent]>([
      ['later request', request('k1', 2, ROTATED_FURTHER, old)],
      ['acknowledgement', rendered('k1', 1, ROTATED, old)],
      ['render failure', renderFailed('k1', 1, 'transform', old)],
      ['processing failure', renderFailed('k1', 1, 'processing', old)],
      ['capture failure', captureFailed('k1', old)],
    ])(
      "ignores the earlier client's %s beside the current request 1",
      (_label, event) => {
        const before = run(handedOver(), request('k1', 1, ROTATED, next))
        const after = reduceTransformState(before, event)

        expect(after).toBe(before)
        expect(after.request?.clientEpoch).toBe(NEXT_CLIENT)
        expect(deriveTransformStatus(after)).toBe('pending')
      },
    )

    it("takes only the current client's answer to the repeated request", () => {
      const asked = run(handedOver(), request('k1', 1, ROTATED, next))
      const answered = run(asked, rendered('k1', 1, ROTATED, next))

      expect(deriveTransformStatus(answered)).toBe('accepted')
      expect(answered.accepted).toEqual({
        captureKey: 'k1',
        clientEpoch: NEXT_CLIENT,
        requestId: 1,
        issued: 2,
        geometry: ROTATED,
      })
    })

    it.each<[string, TransformEvent]>([
      ['success', rendered('k1', 1, ROTATED_FURTHER, old)],
      ['refusal', renderFailed('k1', 1, 'transform', old)],
      ['processing failure', renderFailed('k1', 1, 'processing', old)],
      ['capture failure', captureFailed('k1', old)],
    ])(
      "keeps the current accepted geometry against the earlier client's %s",
      (_label, event) => {
        const current = run(
          handedOver(),
          rotate(6),
          request('k1', 1, ROTATED_FURTHER, next),
          rendered('k1', 1, ROTATED_FURTHER, next),
        )
        expect(deriveTransformStatus(current)).toBe('accepted')

        const after = reduceTransformState(current, event)
        expect(after).toBe(current)
        expect(deriveTransformStatus(after)).toBe('accepted')
        expect(heldTransformGeometry(after)).toEqual(ROTATED_FURTHER)
      },
    )
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
})

describe('transitionSessionTransform', () => {
  /** A session holding `transform`'s geometry, with an export delivered for it. */
  function delivered(transform: TransformState) {
    return createTestSession({
      id: SOURCE,
      transform,
      exportGeometry: heldTransformGeometry(transform),
      exportState: { status: 'ready' },
    })
  }

  it.each<[string, TransformEvent]>([
    ['an edit to the same intent', rotate(3)],
    ['the same capture', capture('k1')],
    ['a repeated acknowledgement', rendered('k1', 1)],
    ['another source', { type: 'reset', sourceId: OTHER_SOURCE }],
  ])('changes nothing for %s', (_label, event) => {
    expect(transitionSessionTransform(delivered(accepted()), event)).toBeNull()
  })

  it('discards the export on every new ask, while the held geometry waits for its answer', () => {
    const away = transitionSessionTransform(delivered(accepted()), rotate(6))!

    expect(away.invalidated).toBe(true)
    expect(away.session.exportState.status).toBe('idle')
    expect(away.session.exportGeometry).toEqual(ROTATED)
    expect(deriveTransformStatus(away.session.transform)).toBe('pending')

    // Asking again for what the held geometry answered is a new ask too.
    const back = transitionSessionTransform(away.session, rotate(3))!
    expect(back.invalidated).toBe(true)
    expect(back.session.exportGeometry).toEqual(ROTATED)
  })

  it('moves the export geometry with the answer the session accepts', () => {
    const asked = run(
      createTransformState(SOURCE),
      rotate(3),
      capture('k1'),
      request('k1', 1),
    )
    const moved = transitionSessionTransform(
      delivered(asked),
      rendered('k1', 1),
    )!

    expect(moved.invalidated).toBe(true)
    expect(moved.session.exportGeometry).toEqual(ROTATED)
    expect(moved.session.exportState.status).toBe('idle')
  })

  it('keeps the export and the intent while a new frame answers the same geometry', () => {
    const session = delivered(accepted())
    const reanswered = [
      capture('k2'),
      request('k2', 2),
      rendered('k2', 2),
    ].reduce((current, event) => {
      const next = transitionSessionTransform(current, event)!
      expect(next.invalidated).toBe(false)
      return next.session
    }, session)

    expect(deriveTransformStatus(reanswered.transform)).toBe('accepted')
    expect(reanswered.transform.accepted?.captureKey).toBe('k2')
    expect(reanswered.transform.intent).toBe(session.transform.intent)
    expect(reanswered.exportGeometry).toBe(session.exportGeometry)
    expect(reanswered.exportState.status).toBe('ready')
  })

  it('clears the export geometry on reset', () => {
    const reset = transitionSessionTransform(delivered(accepted()), {
      type: 'reset',
      sourceId: SOURCE,
    })!

    expect(reset.invalidated).toBe(true)
    expect(reset.session.exportGeometry).toBeNull()
  })

  it('keeps the intent object and the export when a reset only withdraws a neutral request', () => {
    const session = delivered(
      run(createTransformState(SOURCE), capture('k1'), request('k1', 1)),
    )
    const withdrawn = transitionSessionTransform(session, {
      type: 'reset',
      sourceId: SOURCE,
    })!

    expect(withdrawn.invalidated).toBe(false)
    expect(withdrawn.session.transform.request).toBeNull()
    // An export admitted for this intent stays current.
    expect(withdrawn.session.transform.intent).toBe(session.transform.intent)
    expect(withdrawn.session.exportState.status).toBe('ready')
  })
})
