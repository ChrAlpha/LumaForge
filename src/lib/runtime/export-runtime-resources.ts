import type {
  ExportRuntimeResources,
  ExportRuntimeResourcesInput,
} from '@lumaforge/render-engine/policy'

import { getCapabilityVectorSnapshot } from './capability-vector'

type StorageEstimate = {
  quota?: number
  usage?: number
}

type StorageManagerLike = {
  estimate?: () => Promise<StorageEstimate>
}

type NavigatorWithStorage = Navigator & {
  storage?: StorageManagerLike
}

async function probeOpfsReachable(): Promise<boolean> {
  try {
    const storage = (globalThis.navigator as NavigatorWithStorage | undefined)
      ?.storage
    if (typeof storage?.getDirectory !== 'function') return false
    await storage.getDirectory()
    return true
  } catch {
    return false
  }
}

export async function snapshotExportRuntimeResources(
  input: ExportRuntimeResourcesInput,
): Promise<ExportRuntimeResources> {
  const cap = getCapabilityVectorSnapshot()
  if (!cap?.maybeOpfsSupported) {
    return Object.freeze({
      opfsSinkAvailable: false,
      opfsAvailableMB: null,
      streamingSinkAvailable: input.streamingSinkAvailable,
    })
  }

  try {
    const nav = globalThis.navigator as NavigatorWithStorage | undefined
    const estimate = await nav?.storage?.estimate?.()
    const quota = estimate?.quota ?? 0
    const usage = estimate?.usage ?? 0
    const availableBytes = Math.max(0, quota - usage)
    const opfsQuotaOk = quota > 0
    const opfsReachable = opfsQuotaOk ? await probeOpfsReachable() : false

    return Object.freeze({
      opfsSinkAvailable: opfsReachable,
      opfsAvailableMB: opfsQuotaOk
        ? Math.floor(availableBytes / 1_000_000)
        : null,
      streamingSinkAvailable: input.streamingSinkAvailable,
    })
  } catch {
    return Object.freeze({
      opfsSinkAvailable: false,
      opfsAvailableMB: null,
      streamingSinkAvailable: input.streamingSinkAvailable,
    })
  }
}
