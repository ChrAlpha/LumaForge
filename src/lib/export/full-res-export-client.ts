import type { ExportColorGraphDescriptor } from '@lumaforge/luma-color-runtime'
import type {
  BlobOutputResult,
  ExportGeometry,
  ExportOutputResult,
  FullResolutionExportProgress,
  JpegExportMetadata,
} from '@lumaforge/render-engine/export'

import type { ExportAttemptPlan } from './export-plan'
import { createOpfsFileBackedOutputResult } from './output-sink'

/**
 * Where the worker writes the JPEG. An `opfs-file` plan must carry exactly
 * this location; every other plan hands the JPEG back in memory and carries
 * none. The page reserves the directory and guards it with its lifetime
 * lock when it holds one; the worker only writes inside it.
 */
export type FullResWorkerOutputLocation = {
  sink: 'opfs-file'
  tabDirectory: string
  exportId: string
}

export type FullResWorkerFileBackedOutputReference = {
  kind: 'file-backed'
  storage: 'opfs'
  tabDirectory: string
  exportId: string
  filename: string
  byteLength: number
  mimeType: string
  outputFileName?: string
  /** SHA-256 hex of the bytes the result will deliver (metadata included), recorded by the worker at publish time. */
  sha256?: string
  /** Metadata the worker hashed with; the app injects exactly this on delivery. */
  deliveryMetadata?: JpegExportMetadata | null
}

export type FullResWorkerOutputResult =
  | BlobOutputResult
  | FullResWorkerFileBackedOutputReference

/** What one export attempt hands its worker. */
export type FullResExportJob = {
  file: File
  filename: string
  graph: ExportColorGraphDescriptor
  executionPlan: ExportAttemptPlan
  outputLocation?: FullResWorkerOutputLocation
  quality: number
  /** Full-resolution geometry; plain data so it survives structured clone. */
  geometry?: ExportGeometry
}

export type FullResExportWorkerStartMessage = FullResExportJob & {
  kind: 'start'
}

export type FullResExportWorkerRequest =
  | FullResExportWorkerStartMessage
  | { kind: 'cancel' }

export type FullResExportWorkerErrorMessage = {
  kind: 'error'
  message: string
  nextRows?: number
}

export type FullResExportWorkerResponse =
  | { kind: 'progress'; progress: FullResolutionExportProgress }
  | { kind: 'success'; result: FullResWorkerOutputResult }
  | FullResExportWorkerErrorMessage

export type RunFullResolutionJpegExportInWorkerInput = FullResExportJob & {
  signal?: AbortSignal
  onProgress?: (progress: FullResolutionExportProgress) => void
}

function toError(error: unknown, fallback: string) {
  if (error instanceof Error) return error
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message
  ) {
    return new Error(error.message)
  }
  return new Error(fallback)
}

function createWorkerResponseError(response: FullResExportWorkerErrorMessage) {
  const error = new Error(response.message)
  if (typeof response.nextRows === 'number') {
    Object.assign(error, { nextRows: response.nextRows })
  }
  return error
}

function hydrateWorkerOutputResult(
  result: FullResWorkerOutputResult,
): ExportOutputResult {
  if (result.kind === 'blob') {
    return result
  }

  const { storage: _storage, ...opfsReference } = result
  return createOpfsFileBackedOutputResult(opfsReference)
}

function createExportWorker() {
  return new Worker(new URL('./full-res-export.worker.ts', import.meta.url), {
    type: 'module',
  })
}

/**
 * Runs one export attempt on a worker of its own, which is terminated once
 * the attempt succeeds, fails or is cancelled. An attempt whose signal has
 * already aborted starts no worker; aborting a running one asks the worker
 * to stop, then terminates it.
 */
export function runFullResolutionJpegExportInWorker(
  input: RunFullResolutionJpegExportInWorkerInput,
  workerFactory: () => Worker = createExportWorker,
): Promise<ExportOutputResult> {
  const { signal, onProgress, ...job } = input
  if (signal?.aborted) {
    return Promise.reject(new Error('FULL_RES_EXPORT_CANCELLED'))
  }

  return new Promise<ExportOutputResult>((resolve, reject) => {
    let worker: Worker | null = null
    const settle = (outcome: () => void) => {
      signal?.removeEventListener('abort', onAbort)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
        worker = null
      }
      outcome()
    }
    const fail = (error: Error) => settle(() => reject(error))
    const onAbort = () => {
      try {
        worker?.postMessage({
          kind: 'cancel',
        } satisfies FullResExportWorkerRequest)
      } catch (error) {
        fail(toError(error, 'FULL_RES_EXPORT_WORKER_ERROR'))
        return
      }
      fail(new Error('FULL_RES_EXPORT_CANCELLED'))
    }

    try {
      worker = workerFactory()
      worker.onmessage = (event: MessageEvent<FullResExportWorkerResponse>) => {
        const response = event.data
        if (response.kind === 'progress') {
          onProgress?.(response.progress)
        } else if (response.kind === 'success') {
          settle(() => resolve(hydrateWorkerOutputResult(response.result)))
        } else {
          fail(createWorkerResponseError(response))
        }
      }
      worker.onerror = () => fail(new Error('FULL_RES_EXPORT_WORKER_FAILED'))
      worker.onmessageerror = () =>
        fail(new Error('FULL_RES_EXPORT_WORKER_FAILED'))
      signal?.addEventListener('abort', onAbort, { once: true })
      worker.postMessage({
        kind: 'start',
        ...job,
      } satisfies FullResExportWorkerRequest)
    } catch (error) {
      fail(toError(error, 'FULL_RES_EXPORT_WORKER_ERROR'))
    }
  })
}
