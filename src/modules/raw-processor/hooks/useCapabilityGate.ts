import { useEffect, useSyncExternalStore } from 'react'

import {
  getPreviewBackendState,
  getServerPreviewBackendState,
  resolvePreviewBackend,
  subscribePreviewBackend,
} from '~/lib/preview/gpu-backend'
import type { RawPreviewCapability } from '~/lib/preview/raw-preview-capability'
import { resolveRawPreviewCapability } from '~/lib/preview/raw-preview-capability'

export type RawCapabilityGate =
  | ({ ready: true } & RawPreviewCapability)
  | { ready: false; supportStatus: 'checking'; previewMode: null; reason: null }

export function useCapabilityGate(): RawCapabilityGate {
  const state = useSyncExternalStore(
    subscribePreviewBackend,
    getPreviewBackendState,
    getServerPreviewBackendState,
  )
  useEffect(() => {
    // The resolver never rejects: an unusable GPU resolves to the CPU backend.
    void resolvePreviewBackend()
  }, [])
  if (state.status === 'pending') {
    return {
      ready: false,
      supportStatus: 'checking',
      previewMode: null,
      reason: null,
    }
  }
  return { ready: true, ...resolveRawPreviewCapability(state.facts) }
}
