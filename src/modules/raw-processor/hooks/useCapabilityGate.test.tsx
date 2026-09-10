import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import * as glContext from '~/lib/gl/context'
import {
  reportGpuPreviewFailure,
  resetPreviewBackendForTest,
} from '~/lib/preview/gpu-backend'
import { acquireWebGPUDevice } from '~/lib/webgpu/device'

import { useCapabilityGate } from './useCapabilityGate'

vi.mock('~/lib/webgpu/device', () => ({ acquireWebGPUDevice: vi.fn() }))

describe('useCapabilityGate', () => {
  beforeEach(() => {
    resetPreviewBackendForTest()
    vi.mocked(acquireWebGPUDevice).mockRejectedValue(new Error('no WebGPU'))
    vi.spyOn(glContext, 'createWebGL2Context').mockReturnValue({
      getParameter: () => 8192,
      getExtension: () => ({ loseContext: () => {} }),
    } as unknown as WebGL2RenderingContext)
  })
  afterEach(cleanup)
  afterEach(() => vi.restoreAllMocks())
  afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
  })

  it('reports gpu preview when capable + COI', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      toneHighPrecision: true,
    } as glContext.WebGLCapabilities)
    vi.stubGlobal('crossOriginIsolated', true)
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'supported',
        previewMode: 'gpu',
      }),
    )
    vi.unstubAllGlobals()
  })

  it('degrades to cpu preview when precision is low but COI present', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      toneHighPrecision: false,
    } as glContext.WebGLCapabilities)
    vi.stubGlobal('crossOriginIsolated', true)
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'degraded',
        previewMode: 'cpu',
        reason: 'tone-float-precision-low',
      }),
    )
    vi.unstubAllGlobals()
  })

  it('keeps GPU preview available when COI is missing', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      toneHighPrecision: true,
    } as glContext.WebGLCapabilities)
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

  it('forces CPU preview from a local validation query flag when COI is present', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      toneHighPrecision: true,
    } as glContext.WebGLCapabilities)
    vi.stubGlobal('crossOriginIsolated', true)
    window.history.replaceState(null, '', '/raw?forcePreview=cpu')

    const { result } = renderHook(() => useCapabilityGate())

    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'degraded',
        previewMode: 'cpu',
        reason: 'tone-float-precision-low',
      }),
    )
  })

  it('lets the CPU preview validation flag use the low-memory path without COI', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      toneHighPrecision: true,
    } as glContext.WebGLCapabilities)
    vi.stubGlobal('crossOriginIsolated', false)
    window.history.replaceState(null, '', '/raw?forcePreview=cpu')

    const { result } = renderHook(() => useCapabilityGate())

    await waitFor(() =>
      expect(result.current).toMatchObject({
        supportStatus: 'degraded',
        previewMode: 'cpu',
        reason: 'tone-float-precision-low',
      }),
    )
  })

  it('keeps readiness pending until the actual backend is known', async () => {
    let resolve!: (
      lease: Awaited<ReturnType<typeof acquireWebGPUDevice>>,
    ) => void
    vi.mocked(acquireWebGPUDevice).mockReturnValue(
      new Promise((done) => {
        resolve = done
      }),
    )
    const { result } = renderHook(() => useCapabilityGate())
    expect(result.current).toMatchObject({ ready: false, previewMode: null })
    await act(async () =>
      resolve({
        device: { limits: { maxTextureDimension2D: 8192 } },
        release: vi.fn(),
      } as unknown as Awaited<ReturnType<typeof acquireWebGPUDevice>>),
    )
    expect(result.current).toMatchObject({ ready: true, previewMode: 'gpu' })
  })

  it('reacts to runtime GPU failure by selecting the CPU surface', async () => {
    vi.spyOn(glContext, 'detectCapabilities').mockReturnValue({
      webgl2: true,
      maxTextureSize: 8192,
      toneHighPrecision: true,
    } as glContext.WebGLCapabilities)
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() => expect(result.current.previewMode).toBe('gpu'))
    act(() => reportGpuPreviewFailure(new Error('device lost')))
    expect(result.current).toMatchObject({
      ready: true,
      previewMode: 'cpu',
      supportStatus: 'degraded',
    })
  })

  it('surfaces forced GPU failure without mounting another backend', async () => {
    window.history.replaceState(null, '', '/raw?forcePreview=webgpu')
    const { result } = renderHook(() => useCapabilityGate())
    await waitFor(() =>
      expect(result.current).toMatchObject({
        ready: true,
        previewMode: null,
        supportStatus: 'unsupported',
        failureMessage: 'WebGPU preview is unavailable on this device.',
      }),
    )
    expect(glContext.createWebGL2Context).not.toHaveBeenCalled()
  })
})
