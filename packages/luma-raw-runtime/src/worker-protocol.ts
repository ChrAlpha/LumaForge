import type { LumaRawErrorCode } from './errors'
import type {
  LumaEmbeddedPreview,
  LumaRawCameraCalibrationProfile,
  LumaRawExportCapability,
  LumaRawFrame,
  LumaRawProcessedWindow,
  LumaRawProcessedWindowRequest,
  LumaRawRuntimeInfo,
  LumaRawRuntimeMemoryProfile,
  LumaRawSessionInfo,
} from './types'

export type LumaRawWorkerRequestType =
  | 'init'
  | 'openSession'
  | 'extractEmbeddedPreviewFromSession'
  | 'decodeQuickFromSession'
  | 'decodeBoundedHqFromSession'
  | 'probeExportCapabilityFromSession'
  | 'readProcessedWindowFromSession'
  | 'applyCalibrationToSession'
  | 'closeSession'
  | 'cancel'

export type LumaRawWorkerFilePayload = {
  fileBuffer: ArrayBuffer
  fileName: string
  fileSize: number
  /**
   * The browser worker builds its one core from the profile the first init
   * or openSession names; the Node core is built with its profile.
   */
  memoryProfile?: LumaRawRuntimeMemoryProfile
}

export type LumaRawWorkerSessionPayload = {
  sessionId: string
}

export type LumaRawWorkerProcessedWindowPayload = {
  sessionId: string
  request: LumaRawProcessedWindowRequest
}

export type LumaRawWorkerApplyCalibrationPayload = {
  sessionId: string
  cameraCalibration: LumaRawCameraCalibrationProfile
}

export type LumaRawWorkerQuickSessionPayload = {
  sessionId: string
  maxOutputPixels?: number
}

export type LumaRawWorkerBoundedHqSessionPayload = {
  sessionId: string
  maxOutputPixels: number
}

export type LumaRawWorkerRequestPayloadByType = {
  init: {
    requireCrossOriginIsolation: boolean
    memoryProfile: LumaRawRuntimeMemoryProfile
  }
  openSession: LumaRawWorkerFilePayload & { maxOutputPixels?: number }
  extractEmbeddedPreviewFromSession: LumaRawWorkerSessionPayload
  decodeQuickFromSession: LumaRawWorkerQuickSessionPayload
  decodeBoundedHqFromSession: LumaRawWorkerBoundedHqSessionPayload
  probeExportCapabilityFromSession: LumaRawWorkerSessionPayload
  readProcessedWindowFromSession: LumaRawWorkerProcessedWindowPayload
  applyCalibrationToSession: LumaRawWorkerApplyCalibrationPayload
  closeSession: LumaRawWorkerSessionPayload
  cancel: { targetJobId: string }
}

export type LumaRawWorkerRequest<
  T extends LumaRawWorkerRequestType = LumaRawWorkerRequestType,
> = {
  [K in T]: {
    id: string
    type: K
    payload: LumaRawWorkerRequestPayloadByType[K]
  }
}[T]

export type LumaRawWorkerPayloadByType = {
  init: LumaRawRuntimeInfo
  openSession: LumaRawSessionInfo
  extractEmbeddedPreviewFromSession: LumaEmbeddedPreview | null
  decodeQuickFromSession: LumaRawFrame
  decodeBoundedHqFromSession: LumaRawFrame
  probeExportCapabilityFromSession: LumaRawExportCapability
  readProcessedWindowFromSession: LumaRawProcessedWindow
  applyCalibrationToSession: { applied: true }
  closeSession: { closed: true }
  cancel: { cancelled: true }
}

export type LumaRawWorkerSuccess<T extends LumaRawWorkerRequestType> = {
  id: string
  ok: true
  type: T
  payload: LumaRawWorkerPayloadByType[T]
}

export type LumaRawWorkerFailure<T extends LumaRawWorkerRequestType> = {
  id: string
  ok: false
  type: T
  error: {
    code: LumaRawErrorCode
    message: string
  }
}

export type LumaRawWorkerResponse = {
  [T in LumaRawWorkerRequestType]:
    | LumaRawWorkerSuccess<T>
    | LumaRawWorkerFailure<T>
}[LumaRawWorkerRequestType]

export function collectTransferables(payload: unknown): Transferable[] {
  if (!payload || typeof payload !== 'object') return []

  const transferables: Transferable[] = []
  const seenBuffers = new Set<ArrayBuffer>()
  for (const value of Object.values(payload as Record<string, unknown>)) {
    if (value instanceof ArrayBuffer) {
      if (!seenBuffers.has(value)) {
        seenBuffers.add(value)
        transferables.push(value)
      }
    } else if (
      ArrayBuffer.isView(value) &&
      value.buffer instanceof ArrayBuffer
    ) {
      if (!seenBuffers.has(value.buffer)) {
        seenBuffers.add(value.buffer)
        transferables.push(value.buffer)
      }
    }
  }

  return transferables
}
