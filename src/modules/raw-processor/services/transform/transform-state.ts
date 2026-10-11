import type { ExportGeometry } from '@lumaforge/render-engine/export'
import { planExportGeometry } from '@lumaforge/render-engine/export'

import type { TransformRenderFailure } from '~/lib/transform/transform-client'
import type { ManualTransform } from '~/lib/transform/transform-types'
import { NEUTRAL_TRANSFORM } from '~/lib/transform/transform-types'

import type { TransformIntent, TransformState } from '../../model/session'
import { createNeutralTransformIntent } from '../../model/session-factory'

/**
 * Whether the export may reproduce the held geometry as the Transform the
 * controls ask for: nothing is asked (`neutral`), the newest request on the
 * current capture was answered and planned (`accepted`), that answer has not
 * come yet (`pending`), the worker or the export engine refused the geometry
 * (`invalid`), or the frame could not be captured, analysed or rendered
 * (`unavailable`).
 */
export type TransformStatus =
  | 'neutral'
  | 'accepted'
  | 'pending'
  | 'invalid'
  | 'unavailable'

/**
 * Why a full-resolution export cannot reproduce the Transform the controls
 * ask for: every status but a neutral or an accepted one.
 */
export type TransformExportBlock = Exclude<
  TransformStatus,
  'neutral' | 'accepted'
>

/**
 * Every event names the source it was raised for and is ignored by any
 * other. Capture and render events also name their capture, the lifetime of
 * the Transform client that holds it (`clientEpoch`), and their request, so a
 * late answer to something replaced cannot be accepted. A client numbers its
 * sources and requests from scratch, so only the client lifetime tells two
 * clients' events apart when those numbers repeat.
 */
export type TransformEvent =
  /**
   * Merges the named intent fields over the current intent. The merge is
   * shallow: `manual` replaces the manual values whole, so pass all of them.
   */
  | { type: 'edit'; sourceId: string; intent: Partial<TransformIntent> }
  | { type: 'reset'; sourceId: string }
  /**
   * A frame for these inputs, handed to the client `clientEpoch`, replaces
   * the one the answers were given on.
   */
  | {
      type: 'capture'
      sourceId: string
      captureKey: string
      clientEpoch: number
    }
  /** That frame could not be read back, analysed or kept by the worker. */
  | {
      type: 'capture-failed'
      sourceId: string
      captureKey: string
      clientEpoch: number
    }
  | {
      type: 'request'
      sourceId: string
      captureKey: string
      clientEpoch: number
      requestId: number
      geometry: ExportGeometry
    }
  | {
      type: 'rendered'
      sourceId: string
      captureKey: string
      clientEpoch: number
      requestId: number
      /** The geometry the answered request was posted with. */
      geometry: ExportGeometry
      /** The frame it was rendered on; planning is resolution independent. */
      frame: { width: number; height: number }
    }
  | {
      type: 'render-failed'
      sourceId: string
      captureKey: string
      clientEpoch: number
      requestId: number
      failure: TransformRenderFailure
    }

export function isNeutralTransformIntent(intent: TransformIntent) {
  return (
    intent.upright === 'off' &&
    (Object.keys(NEUTRAL_TRANSFORM) as Array<keyof ManualTransform>).every(
      (key) => intent.manual[key] === NEUTRAL_TRANSFORM[key],
    )
  )
}

function sameManual(a: ManualTransform, b: ManualTransform) {
  return (Object.keys(NEUTRAL_TRANSFORM) as Array<keyof ManualTransform>).every(
    (key) => a[key] === b[key],
  )
}

function sameGeometry(a: ExportGeometry, b: ExportGeometry) {
  return (
    a.constrainCrop === b.constrainCrop &&
    a.matrix.length === b.matrix.length &&
    a.matrix.every((value, index) => value === b.matrix[index])
  )
}

function copyGeometry(geometry: ExportGeometry): ExportGeometry {
  return {
    matrix: Array.from(geometry.matrix),
    constrainCrop: geometry.constrainCrop,
  }
}

function plans(
  geometry: ExportGeometry,
  frame: { width: number; height: number },
) {
  try {
    planExportGeometry(geometry, frame)
    return true
  } catch {
    return false
  }
}

/**
 * A new intent withdraws the newest request, since that request asked for
 * the intent it replaces. A neutral intent needs no render and holds no
 * geometry.
 */
function withIntent(state: TransformState, intent: TransformIntent) {
  return {
    ...state,
    intent,
    request: null,
    accepted: isNeutralTransformIntent(intent) ? null : state.accepted,
  }
}

/**
 * Whether the event comes from the client holding the current capture of
 * this source, for that capture.
 */
function onCurrentCapture(
  state: TransformState,
  event: { sourceId: string; captureKey: string; clientEpoch: number },
) {
  const { capture } = state
  return (
    event.sourceId === state.sourceId &&
    capture !== null &&
    capture.key === event.captureKey &&
    capture.clientEpoch === event.clientEpoch
  )
}

/**
 * The request the event answers, when it answers the newest request on the
 * current capture of this source, from the client that posted it; otherwise
 * null.
 */
function answeredRequest(
  state: TransformState,
  event: {
    sourceId: string
    captureKey: string
    clientEpoch: number
    requestId: number
  },
) {
  const { capture, request } = state
  if (
    !onCurrentCapture(state, event) ||
    capture?.failed ||
    !request ||
    request.captureKey !== event.captureKey ||
    request.clientEpoch !== event.clientEpoch ||
    request.requestId !== event.requestId ||
    request.failure
  )
    return null
  return request
}

/**
 * Applies one Transform event. An event that changes nothing, or that is
 * fenced off, returns the state it was given.
 */
export function reduceTransformState(
  state: TransformState,
  event: TransformEvent,
): TransformState {
  if (event.sourceId !== state.sourceId) return state

  switch (event.type) {
    case 'edit': {
      const intent = { ...state.intent, ...event.intent }
      if (
        intent.upright === state.intent.upright &&
        intent.constrainCrop === state.intent.constrainCrop &&
        sameManual(intent.manual, state.intent.manual)
      )
        return state
      return withIntent(state, { ...intent, manual: { ...intent.manual } })
    }
    case 'reset': {
      const neutral = createNeutralTransformIntent()
      if (
        isNeutralTransformIntent(state.intent) &&
        state.intent.constrainCrop === neutral.constrainCrop &&
        !state.request
      )
        return state
      return withIntent(state, neutral)
    }
    case 'capture': {
      // The same frame handed to another client is a new capture: nothing
      // the previous client asked of it can be answered any more.
      if (onCurrentCapture(state, event) && !state.capture?.failed) return state
      return {
        ...state,
        capture: {
          key: event.captureKey,
          clientEpoch: event.clientEpoch,
          failed: false,
        },
        request: null,
      }
    }
    case 'capture-failed': {
      if (!onCurrentCapture(state, event) || state.capture?.failed) return state
      return {
        ...state,
        capture: {
          key: event.captureKey,
          clientEpoch: event.clientEpoch,
          failed: true,
        },
        request: null,
      }
    }
    case 'request': {
      const { request } = state
      if (
        !onCurrentCapture(state, event) ||
        state.capture?.failed ||
        (request && event.requestId <= request.requestId)
      )
        return state
      const issued = state.issuedRequests + 1
      return {
        ...state,
        issuedRequests: issued,
        request: {
          captureKey: event.captureKey,
          clientEpoch: event.clientEpoch,
          requestId: event.requestId,
          issued,
          geometry: copyGeometry(event.geometry),
          failure: null,
        },
      }
    }
    case 'rendered': {
      const request = answeredRequest(state, event)
      if (!request || !sameGeometry(request.geometry, event.geometry))
        return state
      if (isNeutralTransformIntent(state.intent)) return state
      if (state.accepted?.issued === request.issued) return state
      if (!plans(request.geometry, event.frame))
        return { ...state, request: { ...request, failure: 'invalid' } }
      return {
        ...state,
        accepted: {
          captureKey: request.captureKey,
          clientEpoch: request.clientEpoch,
          requestId: request.requestId,
          issued: request.issued,
          geometry: copyGeometry(request.geometry),
        },
      }
    }
    case 'render-failed': {
      const request = answeredRequest(state, event)
      if (!request) return state
      return {
        ...state,
        request: {
          ...request,
          failure: event.failure === 'transform' ? 'invalid' : 'unavailable',
        },
      }
    }
  }
}

export function deriveTransformStatus(state: TransformState): TransformStatus {
  if (isNeutralTransformIntent(state.intent)) return 'neutral'
  const { capture, request, accepted } = state
  if (capture?.failed) return 'unavailable'
  if (request?.failure) return request.failure
  return capture &&
    request &&
    accepted &&
    accepted.captureKey === capture.key &&
    accepted.issued === request.issued
    ? 'accepted'
    : 'pending'
}

/**
 * The geometry the source holds: null for a neutral intent, otherwise the
 * last accepted answer. It stands for the current intent only while the
 * status is `accepted`.
 */
export function heldTransformGeometry(
  state: TransformState,
): ExportGeometry | null {
  if (isNeutralTransformIntent(state.intent)) return null
  return state.accepted?.geometry ?? null
}
