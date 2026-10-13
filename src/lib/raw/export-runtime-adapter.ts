import type {
  LumaRawDecodeSession,
  LumaRawExportCapability,
} from '@lumaforge/luma-raw-runtime'

export type RawExportSession = {
  probeExportCapability: (
    signal?: AbortSignal,
  ) => Promise<LumaRawExportCapability>
  readRawWindow: LumaRawDecodeSession['readRawWindow']
  readProcessedWindow: LumaRawDecodeSession['readProcessedWindow']
}

export function createRawExportSession(
  session: LumaRawDecodeSession,
): RawExportSession {
  return {
    probeExportCapability(signal) {
      return session.probeExportCapability(signal)
    },
    readRawWindow(rect, signal) {
      return session.readRawWindow(rect, signal)
    },
    readProcessedWindow(request, signal) {
      return session.readProcessedWindow(request, signal)
    },
  }
}

export function isRawExportSession(value: unknown): value is RawExportSession {
  if (!value || typeof value !== 'object') {
    return false
  }

  return (
    typeof (value as Partial<RawExportSession>).probeExportCapability ===
      'function' &&
    typeof (value as Partial<RawExportSession>).readRawWindow === 'function' &&
    typeof (value as Partial<RawExportSession>).readProcessedWindow ===
      'function'
  )
}
