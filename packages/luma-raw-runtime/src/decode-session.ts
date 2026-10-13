import type {
  LumaRawDecodeSession,
  LumaRawQuickOptions,
  LumaRawSessionInfo,
} from './types'
import type {
  LumaRawWorkerPayloadByType,
  LumaRawWorkerRequestPayloadByType,
  LumaRawWorkerRequestType,
} from './worker-protocol'

/** Sends one worker request: across the worker boundary or to the core. */
export type LumaRawSessionRequest = <T extends LumaRawWorkerRequestType>(
  type: T,
  payload: LumaRawWorkerRequestPayloadByType[T],
  transfer: Transferable[],
  signal?: AbortSignal,
) => Promise<LumaRawWorkerPayloadByType[T]>

/**
 * The session both runtime entries return: each stage is a session request,
 * and `dispose` closes the session once, best effort.
 */
export function createDecodeSession(
  sessionInfo: LumaRawSessionInfo,
  quickOptions: LumaRawQuickOptions,
  request: LumaRawSessionRequest,
  onDispose?: () => void,
): LumaRawDecodeSession {
  const { sessionId } = sessionInfo
  let disposed = false

  return {
    ...sessionInfo,
    extractEmbeddedPreview(signal) {
      return request(
        'extractEmbeddedPreviewFromSession',
        { sessionId },
        [],
        signal,
      )
    },
    decodeQuick(options = quickOptions, signal) {
      return request(
        'decodeQuickFromSession',
        { sessionId, maxOutputPixels: options.maxOutputPixels },
        [],
        signal,
      )
    },
    decodeBoundedHq(options, signal) {
      return request(
        'decodeBoundedHqFromSession',
        { sessionId, maxOutputPixels: options.maxOutputPixels },
        [],
        signal,
      )
    },
    probeExportCapability(signal) {
      return request(
        'probeExportCapabilityFromSession',
        { sessionId },
        [],
        signal,
      )
    },
    readProcessedWindow(windowRequest, signal) {
      return request(
        'readProcessedWindowFromSession',
        { sessionId, request: windowRequest },
        [],
        signal,
      )
    },
    applyCalibration(profile, signal) {
      const transfer: Transferable[] = [profile.xyzToCamera.buffer]
      if (profile.toneCurveLut) transfer.push(profile.toneCurveLut.buffer)
      return request(
        'applyCalibrationToSession',
        { sessionId, cameraCalibration: profile },
        transfer,
        signal,
      )
    },
    dispose() {
      if (disposed) return
      disposed = true
      onDispose?.()
      void request('closeSession', { sessionId }, []).catch(() => undefined)
    },
  }
}
