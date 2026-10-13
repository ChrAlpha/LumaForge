import { createDecodeSession } from './decode-session'
import { LumaRawRuntimeError } from './errors'
import type {
  LumaRawDecodeSession,
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
          memoryProfile,
          maxOutputPixels: options.maxOutputPixels,
        },
        [fileBuffer],
        signal,
      ),
      readFile,
    )

    return createDecodeSession(sessionInfo, options, (...args) =>
      client.request(...args),
    )
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
