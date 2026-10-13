import type {
  LumaRawWorkerPayloadByType,
  LumaRawWorkerRequest,
  LumaRawWorkerRequestType,
  LumaRawWorkerResponse,
} from '../src/worker-protocol'

// Operations that run against an already open session. openSession and
// closeSession own the session lifetime and are handled outside this policy.
type RawSessionJobType = Extract<
  LumaRawWorkerRequestType,
  | 'extractEmbeddedPreviewFromSession'
  | 'decodeQuickFromSession'
  | 'decodeBoundedHqFromSession'
  | 'probeExportCapabilityFromSession'
  | 'readRawWindowFromSession'
  | 'readProcessedWindowFromSession'
  | 'applyCalibrationToSession'
>

// The request fields that address a cancellation or a failure response.
export type RawWorkerRequestRef = Pick<LumaRawWorkerRequest, 'id' | 'type'>

// The runtime core keeps ownership of cancellation and sessions; a session job
// only consumes a cancellation or looks up a session through these.
export type RawSessionJobContext<Session> = {
  consumeCancellation: (request: RawWorkerRequestRef) => boolean
  requireSession: (sessionId: string) => Session
  cancelledResponse: (request: RawWorkerRequestRef) => LumaRawWorkerResponse
}

type SessionJobPayload<T extends RawSessionJobType> =
  LumaRawWorkerPayloadByType[T]

type RawSessionJob<T extends RawSessionJobType, Session> = {
  run: (session: Session) => SessionJobPayload<T>
}

type RawSessionJobWithOptions<T extends RawSessionJobType, Session, Options> = {
  // Reads and validates request options before the session lookup, so a
  // malformed request is refused as malformed even for an unknown session.
  options: (request: LumaRawWorkerRequest<T>) => Options
  run: (session: Session, options: Options) => SessionJobPayload<T>
}

// A cancellation queued before the job starts refuses it before any option,
// session, or native work. A cancellation that arrives while the native
// operation runs replaces its successful result, so cancelled work is never
// published. Errors propagate unchanged and win over a late cancellation.
export function runSessionJob<T extends RawSessionJobType, Session, Options>(
  context: RawSessionJobContext<Session>,
  request: LumaRawWorkerRequest<T>,
  job: RawSessionJobWithOptions<T, Session, Options>,
): LumaRawWorkerResponse
export function runSessionJob<T extends RawSessionJobType, Session>(
  context: RawSessionJobContext<Session>,
  request: LumaRawWorkerRequest<T>,
  job: RawSessionJob<T, Session>,
): LumaRawWorkerResponse
export function runSessionJob<T extends RawSessionJobType, Session, Options>(
  context: RawSessionJobContext<Session>,
  request: LumaRawWorkerRequest<T>,
  job:
    | RawSessionJob<T, Session>
    | RawSessionJobWithOptions<T, Session, Options>,
): LumaRawWorkerResponse {
  if (context.consumeCancellation(request)) {
    return context.cancelledResponse(request)
  }

  const options = 'options' in job ? job.options(request) : undefined
  const session = context.requireSession(request.payload.sessionId)
  const payload =
    'options' in job ? job.run(session, options as Options) : job.run(session)

  if (context.consumeCancellation(request)) {
    return context.cancelledResponse(request)
  }

  return {
    id: request.id,
    ok: true,
    type: request.type,
    payload,
  } as LumaRawWorkerResponse
}
