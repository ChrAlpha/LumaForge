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
  resetPreviewGpuCapabilityForTest,
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
  webgl2: true,
  maxTextureSize: 8192,
  maxRenderbufferSize: 8192,
}

describe('derivePreviewGpuBudget', () => {
  afterEach(() => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetPreviewGpuCapabilityForTest()
  })

  it('uses the resolved WebGPU limits without opening a WebGL context', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'webgpu',
      maxTextureSize: 4096,
      maxRenderbufferSize: 4096,
      toneHighPrecision: true,
      reason: null,
    })
    const createElement = vi.spyOn(document, 'createElement')
    expect(detectPreviewGpuCapabilitySnapshot()).toEqual({
      webgl2: true,
      maxTextureSize: 4096,
      maxRenderbufferSize: 4096,
    })
    expect(createElement).not.toHaveBeenCalled()
  })

  it('uses the CPU budget after a resolved GPU failure', () => {
    vi.mocked(getPreviewBackendSnapshot).mockReturnValue({
      backend: 'cpu',
      maxTextureSize: 0,
      maxRenderbufferSize: 0,
      toneHighPrecision: false,
      reason: 'webgl2-missing',
    })
    const gpu = detectPreviewGpuCapabilitySnapshot()!
    expect(gpu.webgl2).toBe(false)
    expect(
      derivePreviewGpuBudget({
        capability: baseCapability,
        gpu,
        sourceWidth: 6000,
        sourceHeight: 4000,
      }).dualWebglAllowed,
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
      dualWebglAllowed: true,
      originalReferenceSnapshotMaxPixels: BOUNDED_HQ_PREVIEW_MAX_PIXELS,
    })
  })

  it('caps 3:2 sources to the largest safe pixel count for a 4096 texture limit', () => {
    expect(
      derivePreviewGpuBudget({
        capability: { ...baseCapability, pthread: false },
        gpu: {
          webgl2: true,
          maxTextureSize: 4096,
          maxRenderbufferSize: 4096,
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
      dualWebglAllowed: false,
      originalReferenceSnapshotMaxPixels:
        BOUNDED_HQ_PREVIEW_LOW_MEMORY_MAX_PIXELS,
    })
  })

  it('detects WebGL2 through canvas fallback when strict attributes fail', () => {
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    const gl = {
      MAX_TEXTURE_SIZE: 3379,
      MAX_RENDERBUFFER_SIZE: 34024,
      getExtension: vi.fn((name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: vi.fn() } : null,
      ),
      getParameter: vi.fn((parameter: number) => {
        switch (parameter) {
          case 3379:
          case 34024:
            return 8192
          default:
            return 0
        }
      }),
    }
    const getContext = vi.fn(
      (_name: string, attributes?: WebGLContextAttributes) =>
        attributes ? null : gl,
    )
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext,
    } as unknown as HTMLCanvasElement)

    expect(detectPreviewGpuCapabilitySnapshot()).toEqual({
      webgl2: true,
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
    })
    expect(getContext).toHaveBeenCalledWith('webgl2')
  })

  it('detects WebGL2 through canvas fallback when strict attributes throw', () => {
    const gl = {
      MAX_TEXTURE_SIZE: 3379,
      MAX_RENDERBUFFER_SIZE: 34024,
      getExtension: vi.fn((name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: vi.fn() } : null,
      ),
      getParameter: vi.fn((parameter: number) => {
        switch (parameter) {
          case 3379:
          case 34024:
            return 8192
          default:
            return 0
        }
      }),
    }
    const getContext = vi.fn(
      (_name: string, attributes?: WebGLContextAttributes) => {
        if (attributes) throw new Error('strict attributes rejected')
        return gl
      },
    )
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext,
    } as unknown as HTMLCanvasElement)

    expect(detectPreviewGpuCapabilitySnapshot()).toEqual({
      webgl2: true,
      maxTextureSize: 8192,
      maxRenderbufferSize: 8192,
    })
    expect(getContext).toHaveBeenCalledWith('webgl2')
  })
})
