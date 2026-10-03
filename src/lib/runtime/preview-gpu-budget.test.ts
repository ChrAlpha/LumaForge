import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPreviewBackendSnapshot } from '~/lib/preview/gpu-backend'
import {
  BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
  BOUNDED_HQ_PREVIEW_MAX_PIXELS,
} from '~/lib/raw/decoder'

import type { CapabilityVector } from './capability-vector'
import {
  derivePreviewGpuBudget,
  detectPreviewGpuCapabilitySnapshot,
} from './preview-gpu-budget'

vi.mock('~/lib/preview/gpu-backend', () => ({
  getPreviewBackendSnapshot: vi.fn(() => null),
}))

const baseCapability: CapabilityVector = {
  coi: true,
  pthread: true,
  deviceMemoryGB: null,
  hwConcurrency: 8,
  webKitClass: 'chromium',
  deviceFormFactor: 'desktop',
  maybeOpfsSupported: true,
}

const strongGpu = {
  webgpu: true,
  maxTextureSize: 8192,
}

describe('derivePreviewGpuBudget', () => {
  afterEach(() => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses the resolved WebGPU limits without opening a canvas', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'webgpu',
      maxTextureSize: 4096,
      reason: null,
    })
    const createElement = vi.spyOn(document, 'createElement')
    expect(detectPreviewGpuCapabilitySnapshot()).toEqual({
      webgpu: true,
      maxTextureSize: 4096,
    })
    expect(createElement).not.toHaveBeenCalled()
  })

  it('uses the CPU budget after a resolved GPU failure', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'cpu',
      maxTextureSize: 0,
      reason: 'gpu-preview-failed',
    })
    const gpu = detectPreviewGpuCapabilitySnapshot()!
    expect(gpu.webgpu).toBe(false)
    expect(
      derivePreviewGpuBudget({
        capability: baseCapability,
        gpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }).dualGpuAllowed,
    ).toBe(false)
  })

  it('allows 12MP bounded HQ preview on a strong GPU without requiring pthread', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, pthread: false },
        gpu: strongGpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
      dualGpuAllowed: true,
      originalReferenceSnapshotMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    })
  })

  it('caps 3:2 sources to the largest safe pixel count for a 4096 texture limit', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, pthread: false },
        gpu: {
          webgpu: true,
          maxTextureSize: 4096,
        },
        sourceWidth: 6000,
        sourceHeight: 4000,
      }).boundedHqMaxPixels,
    ).toBe(11_184_810)
  })

  it('keeps known low-memory devices on the low-memory preview ceiling', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, deviceMemoryGB: 4 },
        gpu: strongGpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }),
    ).toMatchObject({
      boundedHqMaxPixels: BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
      dualGpuAllowed: false,
      originalReferenceSnapshotMaxPixels:
        BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
    })
  })

  it('reports no GPU facts before the preview backend resolves', () => {
    const createElement = vi.spyOn(document, 'createElement')
    expect(detectPreviewGpuCapabilitySnapshot()).toBeNull()
    expect(createElement).not.toHaveBeenCalled()
  })
})
