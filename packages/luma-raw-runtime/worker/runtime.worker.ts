import type { LumaRawErrorCode } from '../src/errors'
import { normalizeRawRuntimeError } from '../src/errors'
import type { LumaRawRuntimeMemoryProfile } from '../src/types'
import type {
  LumaRawWorkerRequest,
  LumaRawWorkerResponse,
} from '../src/worker-protocol'
import { collectTransferables } from '../src/worker-protocol'
import { loadNativeFactory } from './load-native-module'
import { createRuntimeCore } from './runtime-core'

// One client owns this worker, so one core serves it: built for the profile
// the first init or openSession names.
let corePromise: ReturnType<typeof createCore> | undefined

async function createCore(memoryProfile: LumaRawRuntimeMemoryProfile) {
  const nativeFactory = await loadNativeFactory({ memoryProfile })
  return createRuntimeCore(nativeFactory, { memoryProfile })
}

function failureResponse(
  request: LumaRawWorkerRequest,
  error: unknown,
  fallbackCode: LumaRawErrorCode,
): LumaRawWorkerResponse {
  const runtimeError = normalizeRawRuntimeError(error, fallbackCode)

  return {
    id: request.id,
    ok: false,
    type: request.type,
    error: {
      code: runtimeError.code,
      message: runtimeError.message,
    },
  } as LumaRawWorkerResponse
}

function requestMemoryProfile(
  request: LumaRawWorkerRequest,
): LumaRawRuntimeMemoryProfile {
  return request.type === 'init' || request.type === 'openSession'
    ? (request.payload.memoryProfile ?? 'desktop')
    : 'desktop'
}

self.onmessage = async (event: MessageEvent<LumaRawWorkerRequest>) => {
  const request = event.data
  let response: LumaRawWorkerResponse

  let core: Awaited<ReturnType<typeof createCore>>
  try {
    corePromise ??= createCore(requestMemoryProfile(request))
    core = await corePromise
  } catch (error) {
    corePromise = undefined
    response = failureResponse(request, error, 'RAW_RUNTIME_UNAVAILABLE')
    postResponse(request, response)
    return
  }

  try {
    response = await core.handleRequest(request)
  } catch (error) {
    response = failureResponse(request, error, 'RAW_WORKER_PROTOCOL_ERROR')
  }

  postResponse(request, response)
}

function postResponse(
  request: LumaRawWorkerRequest,
  response: LumaRawWorkerResponse,
) {
  try {
    const transfer = response.ok ? collectTransferables(response.payload) : []
    self.postMessage(response satisfies LumaRawWorkerResponse, transfer)
  } catch (error) {
    if (!response.ok) return

    const transferFailure = failureResponse(
      request,
      error,
      'RAW_WORKER_PROTOCOL_ERROR',
    )
    try {
      self.postMessage(transferFailure satisfies LumaRawWorkerResponse)
    } catch {
      // Nothing else can be reported if the worker cannot post a plain failure.
    }
  }
}
