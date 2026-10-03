import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  reportGpuPreviewFailure,
  resetPreviewBackendForTest,
} from '~/lib/preview/gpu-backend'
import { acquireWebGPUDevice } from '~/lib/webgpu/device'

import { useCapabilityGate } from './useCapabilityGate'

vi.mock('~/lib/webgpu/device', () => ({ acquireWebGPUDevice: vi.fn() }))

type Lease = Awaited<ReturnType<typeof acquireWebGPUDevice>>

function createLease(): Lease {
  return {
    device: { limits: { maxTextureDimension2D: 8192 } },
    release: vi.fn(),
  } as unknown as Lease
}

describe('useCapabilityGate', () => {
  beforeEach(() => {
    resetPreviewBackendForTest()
    vi.mocked(acquireWebGPUDevice).mockResolvedValue(createLease())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(cleanup)
  afterEach(() => vi.restoreAllMocks())
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  it('reports gpu preview when WebGPU is available', async () => {
    vi.stubGlobal('crossOriginIsolated', true)
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'supported',
        previewMode: 'gpu',
        reason: null,
      }),
    )
  })

  it('keeps GPU preview available when COI is missing', async () => {
    vi.stubGlobal('crossOriginIsolated', false)
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'supported',
        previewMode: 'gpu',
        reason: null,
      }),
    )
  })

  it('degrades to cpu preview when WebGPU is unavailable', async () => {
    vi.mocked(acquireWebGPUDevice).mockRejectedValue(new Error('no WebGPU'))
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'degraded',
        previewMode: 'cpu',
        reason: 'webgpu-unavailable',
      }),
    )
  })

  it.each([true, false])(
    'forces CPU preview from a local validation query flag (COI %s)',
    async (crossOriginIsolated) => {
      vi.stubGlobal('crossOriginIsolated', crossOriginIsolated)
      window.history.replaceState(null, '', '/raw?forcePreview=cpu')

      const { result } = renderHook(() => useCapabilityGate())

      await waitFor(() =>
        expect(result.current).toMatchObject({
          supportStatus: 'degraded',
          previewMode: 'cpu',
          reason: 'forced',
        }),
      )
      expect(acquireWebGPUDevice).not.toHaveBeenCalled()
    },
  )

  it('keeps readiness pending until the actual backend is known', async () => {
    let resolve!: (lease: Lease) => void
    vi.mocked(acquireWebGPUDevice).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { result } = renderHook(() => useCapabilityGate())
    expect(result.current).toMatchObject({ ready: false, previewMode: null })
    await act(async () => resolve(createLease()))
    expect(result.current).toMatchObject({ ready: true, previewMode: 'gpu' })
  })

  it('reacts to runtime GPU failure by selecting the CPU surface', async () => {
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() => expect(result.current.previewMode).toBe('gpu'))
    act(() => reportGpuPreviewFailure())
    expect(result.current).toMatchObject({
      ready: true,
      previewMode: 'cpu',
      supportStatus: 'degraded',
      reason: 'gpu-preview-failed',
    })
  })
})
