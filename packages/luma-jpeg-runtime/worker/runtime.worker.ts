import { loadNativeJpegEncoderFactory } from './load-native-module'
import type {
  JpegWorkerErrorResponse,
  JpegWorkerRequest,
  JpegWorkerResponse,
} from './runtime-core'
import { createJpegRuntimeCore } from './runtime-core'

let core: ReturnType<typeof createJpegRuntimeCore> | undefined

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return 'JPEG_RUNTIME_WORKER_ERROR'
}

function failureResponse(
  request: JpegWorkerRequest,
  error: unknown,
): JpegWorkerErrorResponse {
  return {
    id: request.id,
    ok: false,
    type: request.type,
    error: {
      message: errorMessage(error),
    },
  }
}

self.onmessage = async (event: MessageEvent<JpegWorkerRequest>) => {
  const request = event.data

  try {
    core ??= createJpegRuntimeCore(loadNativeJpegEncoderFactory, {
      onResponse(response) {
        self.postMessage(response)
      },
    })
    const response: JpegWorkerResponse = await core.handleRequest(request)
    self.postMessage(response)
  } catch (error) {
    self.postMessage(failureResponse(request, error))
  }
}
