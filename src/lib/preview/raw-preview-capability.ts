import type { CpuPreviewReason, PreviewBackendFacts } from './gpu-backend'

export type RawPreviewCapability =
  | { supportStatus: 'unsupported'; previewMode: null; reason: 'coi-missing' }
  | { supportStatus: 'degraded'; previewMode: 'cpu'; reason: CpuPreviewReason }
  | { supportStatus: 'supported'; previewMode: 'gpu'; reason: null }

/**
 * Pure preview-capability decision. RAW runtime memory-profile selection is
 * handled by the runtime policy layer; this gate only decides whether the
 * interactive preview runs on WebGPU or degrades to the CPU executor.
 */
export function resolveRawPreviewCapability(
  facts: Pick<PreviewBackendFacts, 'backend' | 'reason'>,
): RawPreviewCapability {
  if (facts.backend === 'cpu') {
    return {
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: facts.reason ?? 'webgpu-unavailable',
    }
  }
  return { supportStatus: 'supported', previewMode: 'gpu', reason: null }
}
