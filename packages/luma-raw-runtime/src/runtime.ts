import { LumaRawRuntimeError } from './errors'
import type {
  LumaRawBoundedHqOptions,
  LumaRawCameraCalibrationProfile,
  LumaRawDecodeSession,
  LumaRawExportCapability,
  LumaRawQuickOptions,
  LumaRawRuntime,
  LumaRawRuntimeInfo,
  LumaRawRuntimeMemoryProfile,
  LumaRawSessionInfo,
  LumaRawTimings,
} from './types'
import { LumaRawWorkerClient } from './worker-client'

export type LumaRawRuntimeOptions = {
  requireCrossOriginIsolation?: boolean
  memoryProfile?: LumaRawRuntimeMemoryProfile
  workerFactory?: () => Worker
}

const defaultWorkerFactory = () =>
  new Worker(new URL('../worker/runtime.worker.ts', import.meta.url), {
    type: 'module',
  })

function createJobCancelledError() {
  return new LumaRawRuntimeError(
    'RAW_JOB_CANCELLED',
    'RAW runtime job was cancelled.',
  )
}

function mergeReadTimings<T extends { timings: LumaRawTimings }>(
  result: T,
  readFile: number,
): T {
  return {
    ...result,
    timings: {
      ...result.timings,
      readFile,
      total: result.timings.total + readFile,
    },
  }
}

function mergeSessionReadTimings(
  sessionInfo: LumaRawSessionInfo,
  readFile: number,
): LumaRawSessionInfo {
  return {
    ...sessionInfo,
    probe: mergeReadTimings(sessionInfo.probe, readFile),
    timings: {
      ...sessionInfo.timings,
      readFile,
      total: sessionInfo.timings.total + readFile,
    },
  }
}

function createFilePayload(file: File, fileBuffer: ArrayBuffer) {
  return {
    fileBuffer,
    fileName: file.name,
    fileSize: file.size,
  }
}

async function readFileBuffer(file: File, signal?: AbortSignal) {
  const start = performance.now()
  const fileBuffer = await readFileBytes(file, signal)
  return {
    fileBuffer,
    readFile: performance.now() - start,
  }
}

function readFileBytes(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) {
    return Promise.reject(createJobCancelledError())
  }

  const readPromise = file.arrayBuffer()
  return signal ? withAbortSignal(readPromise, signal) : readPromise
}

function withAbortSignal<T>(promise: Promise<T>, signal: AbortSignal) {
  if (signal.aborted) {
    return Promise.reject(createJobCancelledError())
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(createJobCancelledError())
    }

    signal.addEventListener('abort', onAbort, { once: true })

    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function assertCrossOriginIsolation(required: boolean) {
  if (!required) return

  const isolated =
    typeof globalThis.crossOriginIsolated === 'boolean'
      ? globalThis.crossOriginIsolated
      : false

  if (!isolated) {
    throw new LumaRawRuntimeError(
      'RAW_CROSS_ORIGIN_ISOLATION_REQUIRED',
      'Cross-origin isolation is required for pthread RAW decode.',
    )
  }
}

export function createLumaRawRuntime(
  options: LumaRawRuntimeOptions = {},
): LumaRawRuntime {
  const memoryProfile = options.memoryProfile ?? 'desktop'
  const requireCrossOriginIsolation =
    options.requireCrossOriginIsolation ?? memoryProfile === 'desktop'
  const client = new LumaRawWorkerClient(
    options.workerFactory ?? defaultWorkerFactory,
    { memoryProfile },
  )

  async function openSession(
    file: File,
    options: LumaRawQuickOptions = {},
    signal?: AbortSignal,
  ): Promise<LumaRawDecodeSession> {
    const { fileBuffer, readFile } = await readFileBuffer(file, signal)
    const sessionInfo = mergeSessionReadTimings(
      await client.request(
        'openSession',
        {
          ...createFilePayload(file, fileBuffer),
          maxOutputPixels: options.maxOutputPixels,
        },
        [fileBuffer],
        signal,
      ),
      readFile,
    )

    let disposed = false
    const closeSession = () => {
      if (disposed) return
      disposed = true
      void client
        .request('closeSession', { sessionId: sessionInfo.sessionId })
        .catch(() => undefined)
    }

    return {
      ...sessionInfo,
      extractEmbeddedPreview(stageSignal?: AbortSignal) {
        return client.request(
          'extractEmbeddedPreviewFromSession',
          { sessionId: sessionInfo.sessionId },
          [],
          stageSignal,
        )
      },
      probeExportCapability(
        stageSignal?: AbortSignal,
      ): Promise<LumaRawExportCapability> {
        return client.request(
          'probeExportCapabilityFromSession',
          { sessionId: sessionInfo.sessionId },
          [],
          stageSignal,
        )
      },
      readProcessedWindow(request, stageSignal?: AbortSignal) {
        return client.request(
          'readProcessedWindowFromSession',
          { sessionId: sessionInfo.sessionId, request },
          [],
          stageSignal,
        )
      },
      applyCalibration(
        profile: LumaRawCameraCalibrationProfile,
        stageSignal?: AbortSignal,
      ) {
        const transferables: Transferable[] = [profile.xyzToCamera.buffer]
        if (profile.toneCurveLut) {
          transferables.push(profile.toneCurveLut.buffer)
        }
        return client.request(
          'applyCalibrationToSession',
          {
            sessionId: sessionInfo.sessionId,
            cameraCalibration: profile,
          },
          transferables,
          stageSignal,
        )
      },
      decodeQuick(
        stageOptions: LumaRawQuickOptions = options,
        stageSignal?: AbortSignal,
      ) {
        return client.request(
          'decodeQuickFromSession',
          {
            sessionId: sessionInfo.sessionId,
            maxOutputPixels: stageOptions.maxOutputPixels,
          },
          [],
          stageSignal,
        )
      },
      decodeBoundedHq(
        stageOptions: LumaRawBoundedHqOptions,
        stageSignal?: AbortSignal,
      ) {
        return client.request(
          'decodeBoundedHqFromSession',
          {
            sessionId: sessionInfo.sessionId,
            maxOutputPixels: stageOptions.maxOutputPixels,
          },
          [],
          stageSignal,
        )
      },
      dispose: closeSession,
    }
  }

  return {
    async init(): Promise<LumaRawRuntimeInfo> {
      assertCrossOriginIsolation(requireCrossOriginIsolation)
      return client.request('init', {
        requireCrossOriginIsolation,
        memoryProfile,
      })
    },

    openSession,

    dispose() {
      client.dispose()
    },
  }
}
