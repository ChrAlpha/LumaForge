import { describe, expect, it } from 'vitest'

import { resolveRawPreviewCapability } from './raw-preview-capability'

describe('resolveRawPreviewCapability', () => {
  it('is supported/gpu when WebGPU is the resolved backend', () => {
    expect(
      resolveRawPreviewCapability({ backend: 'webgpu', reason: null }),
    ).toEqual({
      supportStatus: 'supported',
      previewMode: 'gpu',
      reason: null,
    })
  })

  it.each(['webgpu-unavailable', 'gpu-preview-failed', 'forced'] as const)(
    'degrades to the CPU preview with reason %s',
    (reason) => {
      expect(resolveRawPreviewCapability({ backend: 'cpu', reason })).toEqual({
        supportStatus: 'degraded',
        previewMode: 'cpu',
        reason,
      })
    },
  )

  it('defaults a CPU backend without a reason to webgpu-unavailable', () => {
    expect(
      resolveRawPreviewCapability({ backend: 'cpu', reason: null }),
    ).toMatchObject({ supportStatus: 'degraded', reason: 'webgpu-unavailable' })
  })
})
