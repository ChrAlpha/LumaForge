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
  | {
      ready: true
      supportStatus: 'unsupported'
      previewMode: null
      reason: 'gpu-unavailable'
      failureMessage: string
    }

export function useCapabilityGate(): RawCapabilityGate {
  const state = useSyncExternalStore(
    subscribePreviewBackend,
    getPreviewBackendState,
    getServerPreviewBackendState,
  )
  useEffect(() => {
    // Failures are published by the resolver and rendered by this same store.
    void resolvePreviewBackend().catch(() => {})
  }, [])
  if (state.status === 'pending') {
    return {
      ready: false,
      supportStatus: 'checking',
      previewMode: null,
      reason: null,
    }
  }
  if (state.status === 'failed') {
    return {
      ready: true,
      supportStatus: 'unsupported',
      previewMode: null,
      reason: 'gpu-unavailable',
      failureMessage: state.error.message,
    }
  }
  if (state.facts.backend === 'cpu') {
    return {
      ready: true,
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: state.facts.reason ?? 'webgl2-missing',
    }
  }
  return {
    ready: true,
    ...resolveRawPreviewCapability({
      webgl2: true,
      toneHighPrecision: state.facts.toneHighPrecision,
    }),
  }
}
