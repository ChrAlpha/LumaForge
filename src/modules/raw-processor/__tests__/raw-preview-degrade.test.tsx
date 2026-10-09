/**
 * Tests for the CPU preview safety-net degraded path in RawProcessorView.
 *
 * Task 8 — verify that:
 *   - degraded/cpu renders the normal workspace shell (NOT full-page UnsupportedState)
 *   - degraded/cpu renders CpuPreviewBanner; GPU PreviewCanvas is absent
 *   - unsupported/coi-missing still renders the full-page UnsupportedState block
 *   - a failed primary GPU LUT upload moves the real capability gate to the
 *     CPU preview without dropping the selected look
 */

import type { LUTData } from '@lumaforge/luma-color-runtime'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getPreviewBackendSnapshot,
  resetPreviewBackendForTest,
  subscribePreviewBackend,
} from '~/lib/preview/gpu-backend'
import type { DecodedImage } from '~/lib/raw/decoder'
import { acquireWebGPUDevice } from '~/lib/webgpu/device'
import { RawProcessingPipeline } from '~/lib/webgpu/raw-processing-pipeline'

import { useCpuPreview } from '../hooks/useCpuPreview'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawProcessorView } from '../RawProcessorView'
import {
  getLut,
  getProcessingParams,
  resetToDefaults,
} from '../state/workflow.atoms'

const gpu = vi.hoisted(() => ({
  executors: [] as Array<{
    canvas: HTMLCanvasElement
    uploadImage: ReturnType<typeof vi.fn>
    uploadLUT: ReturnType<typeof vi.fn>
    render: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
  }>,
}))

const workflowHarness = vi.hoisted(() => ({
  image: null as { current: DecodedImage } | null,
  latest: null as UseRawWorkflowReturn | null,
}))

// Mock capability gate — same pattern as raw-route-shell.test.tsx
vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: vi.fn(),
}))

vi.mock('~/lib/webgpu/device', () => ({ acquireWebGPUDevice: vi.fn() }))

// The WebGPU executor behind the real preview facade.
vi.mock('~/lib/webgpu/pipeline', () => ({
  WebGPUProcessingPipeline: vi.fn((canvas: HTMLCanvasElement) => {
    const executor = {
      canvas,
      initialize: vi.fn(async () => {}),
      onLost: vi.fn(),
      uploadImage: vi.fn(),
      clearImage: vi.fn(),
      uploadLUT: vi.fn(),
      clearLUT: vi.fn(),
      setParams: vi.fn(),
      getParams: vi.fn(() => ({})),
      render: vi.fn(() => ({ totalTime: 1 })),
      waitForGpu: vi.fn(async () => {}),
      readProcessedPixelsAsync: vi.fn(async () => null),
      resize: vi.fn(),
      dispose: vi.fn(),
      getResourceStats: vi.fn(() => ({ estimatedBytes: 0 })),
    }
    gpu.executors.push(executor)
    return executor
  }),
}))

// The real workflow, with a decoded image standing in for a finished decode.
vi.mock('../hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hooks')>()
  return {
    ...actual,
    useRawWorkflow: () => {
      const workflow = actual.useRawWorkflow()
      workflowHarness.latest = workflow
      const image = workflowHarness.image
      return image
        ? {
            ...workflow,
            hasImage: true,
            decodedImageRef: image,
            decodedImageVersion: 1,
            // The descriptor the producer mints when it accepts the frame.
            decodedFrame: {
              sessionId: 'session-1',
              frameId: 'decoded-frame-1',
              stage: 'bounded-hq',
              width: image.current.width,
              height: image.current.height,
              exposure: {
                kind: 'source-pin',
                value: image.current.renderExposure,
              },
              quickPredecessorFrameId: null,
            },
            displaySource: 'bounded-hq',
          }
        : workflow
    },
  }
})

// Mock useCpuPreview so it doesn't try to spin up a worker in jsdom
vi.mock('../hooks/useCpuPreview', () => ({
  useCpuPreview: vi.fn(() => ({
    frame: null,
    inFlight: false,
    failureReason: null,
  })),
}))

const mockedUseCapabilityGate = vi.mocked(
  (await import('../hooks/useCapabilityGate')).useCapabilityGate,
)
const { useCapabilityGate: actualUseCapabilityGate } = await vi.importActual<
  typeof import('../hooks/useCapabilityGate')
>('../hooks/useCapabilityGate')

beforeEach(() => {
  resetToDefaults()
  localStorage.clear()

  mockedUseCapabilityGate.mockReset()

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

describe('rawProcessorView CPU preview degraded path', () => {
  it('renders workspace shell (not UnsupportedState) when degraded/cpu with gpu-preview-failed', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: 'gpu-preview-failed',
    })

    const { container } = render(<RawProcessorView />)

    // Must NOT render the full-page unsupported block
    expect(
      screen.queryByText('This browser cannot run the RAW Lab'),
    ).not.toBeInTheDocument()

    // Must render the normal workspace viewport shell
    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )
    expect(viewportShell).not.toBeNull()
    expect(viewportShell).not.toHaveAttribute(
      'data-raw-lab-state',
      'unsupported',
    )

    // CPU degrade banner must be present
    const banner = container.querySelector('[data-cpu-preview-banner]')
    expect(banner).not.toBeNull()

    // GPU PreviewCanvas must NOT be in the DOM
    // PreviewCanvas renders a canvas inside a .raw-lab-preview-frame element;
    // the specific marker is the data attribute set on the canvas wrapper.
    expect(container.querySelector('[data-preview-canvas]')).toBeNull()

    // Empty CPU mode must keep the normal RAW chooser instead of showing the
    // post-decode CPU-preview failure placeholder.
    expect(
      screen.getByRole('button', { name: /choose raw/i }),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-testid="cpu-preview-unavailable"]'),
    ).toBeNull()
  })

  it('renders workspace shell (not UnsupportedState) when degraded/cpu with webgpu-unavailable', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'degraded',
      previewMode: 'cpu',
      reason: 'webgpu-unavailable',
    })

    const { container } = render(<RawProcessorView />)

    expect(
      screen.queryByText('This browser cannot run the RAW Lab'),
    ).not.toBeInTheDocument()

    const banner = container.querySelector('[data-cpu-preview-banner]')
    expect(banner).not.toBeNull()
  })

  it('renders full-page UnsupportedState when unsupported/coi-missing', () => {
    mockedUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'unsupported',
      previewMode: null,
      reason: 'coi-missing',
    })

    const { container } = render(<RawProcessorView />)

    // Full-page unsupported block must be present
    expect(
      screen.getByText('This browser cannot run the RAW Lab'),
    ).toBeInTheDocument()

    const viewportShell = container.querySelector(
      '[data-raw-lab-shell="viewport"]',
    )
    expect(viewportShell).toHaveAttribute('data-raw-lab-state', 'unsupported')

    // The reason shown must NOT be the raw literal 'coi-missing'
    expect(screen.queryByText('coi-missing')).not.toBeInTheDocument()
  })
})

const decodedImage: DecodedImage = {
  width: 4,
  height: 3,
  channels: 3,
  bitsPerChannel: 16,
  data: new Uint16Array(4 * 3 * 3),
  layout: 'rgb-u16',
  colorSpace: 'linear-prophoto-rgb',
  source: 'bounded-hq',
  metadata: { width: 4, height: 3 },
  renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
}

function createCubeFile(title: string, name: string, size = 17) {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`, '']
  const step = 1 / (size - 1)
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        lines.push(`${r * step} ${g * step} ${b * step}`)
      }
    }
  }
  const content = lines.join('\n')
  // jsdom's File has no text()/arrayBuffer(); the loader reads text instead.
  return Object.assign(new File([content], name), {
    text: () => Promise.resolve(content),
  })
}

function primaryExecutor() {
  return gpu.executors.find((executor) =>
    executor.canvas.classList.contains('raw-preview-canvas'),
  )
}

async function renderGpuPreviewWithImage() {
  workflowHarness.image = { current: decodedImage }
  const view = render(<RawProcessorView />)
  const primary = await waitFor(() => {
    const executor = primaryExecutor()
    expect(executor?.uploadImage).toHaveBeenCalled()
    return executor!
  })
  expect(getPreviewBackendSnapshot()).toMatchObject({ backend: 'webgpu' })
  return { ...view, primary }
}

describe('rawProcessorView GPU LUT upload failure', () => {
  beforeEach(() => {
    gpu.executors.length = 0
    resetPreviewBackendForTest()
    vi.mocked(acquireWebGPUDevice).mockResolvedValue({
      device: { limits: { maxTextureDimension2D: 8192 } },
      release: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof acquireWebGPUDevice>>)
    mockedUseCapabilityGate.mockImplementation(actualUseCapabilityGate)
    vi.mocked(useCpuPreview).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    workflowHarness.image = null
    workflowHarness.latest = null
    resetPreviewBackendForTest()
    vi.restoreAllMocks()
  })

  it('moves a failed primary LUT upload to the CPU preview with the selected look intact', async () => {
    const { container, primary } = await renderGpuPreviewWithImage()
    const published = vi.fn()
    const unsubscribe = subscribePreviewBackend(published)
    let rendersAtFailure = -1
    primary.uploadLUT.mockImplementation(() => {
      rendersAtFailure = primary.render.mock.calls.length
      throw new Error('Failed to create LUT texture')
    })

    let outcome: Awaited<ReturnType<UseRawWorkflowReturn['loadLUT']>> | null =
      null
    await act(async () => {
      outcome = await workflowHarness.latest!.loadLUT(
        createCubeFile('Failing Look', 'failing-look.cube'),
      )
    })
    expect(outcome).toBe('loaded')
    await waitFor(() => expect(primary.uploadLUT).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        container.querySelector('[data-cpu-preview-banner]'),
      ).not.toBeNull(),
    )
    unsubscribe()

    // One demotion through the capability gate; the GPU canvas never drew a
    // LUT-less frame for the selected look before it was replaced.
    expect(published).toHaveBeenCalledOnce()
    expect(getPreviewBackendSnapshot()).toEqual({
      backend: 'cpu',
      maxTextureSize: 0,
      reason: 'gpu-preview-failed',
    })
    expect(primary.render).toHaveBeenCalledTimes(rendersAtFailure)
    expect(primary.dispose).toHaveBeenCalled()

    // The RAW surface stays mounted, now on the CPU stage with a notice.
    const shell = container.querySelector('[data-raw-lab-shell="viewport"]')
    expect(shell).toHaveAttribute('data-raw-lab-state', 'loaded')
    expect(container.querySelector('[data-raw-preview-frame]')).toBeNull()
    const banners = container.querySelectorAll('[data-cpu-preview-banner]')
    expect(banners).toHaveLength(1)
    expect(banners[0]).toHaveAttribute('role', 'status')
    expect(banners[0]).toHaveTextContent('GPU preview unavailable')

    // The selected look survives and drives the CPU preview unchanged.
    const lutData = workflowHarness.latest!.lutDataRef.current
    expect(lutData).not.toBeNull()
    expect(getLut()?.title).toBe('Failing Look')
    expect(getProcessingParams()).toMatchObject({ styleKind: 'custom' })
    expect(vi.mocked(useCpuPreview).mock.lastCall?.[0]).toMatchObject({
      enabled: true,
      image: decodedImage,
      params: {
        lut: lutData,
        styleKind: 'custom',
        intensity: getProcessingParams().intensity,
      },
    })
  })

  it('keeps an auxiliary LUT upload failure from demoting the RAW surface', async () => {
    const { container } = await renderGpuPreviewWithImage()
    const published = vi.fn()
    const unsubscribe = subscribePreviewBackend(published)
    const auxiliary = new RawProcessingPipeline(
      document.createElement('canvas'),
      { reportFailures: false },
    )
    await auxiliary.initialize()
    gpu.executors.at(-1)!.uploadLUT.mockImplementation(() => {
      throw new Error('Failed to create LUT texture')
    })
    const lut: LUTData = {
      size: 2,
      data: new Float32Array(2 * 2 * 2 * 3),
      domainMin: [0, 0, 0],
      domainMax: [1, 1, 1],
      inputProfile: 'display-srgb',
      profileResolution: { kind: 'unknown' },
    }

    expect(() => auxiliary.uploadLUT(lut)).toThrow(
      'Failed to create LUT texture',
    )
    auxiliary.dispose()
    unsubscribe()

    expect(published).not.toHaveBeenCalled()
    expect(getPreviewBackendSnapshot()).toMatchObject({ backend: 'webgpu' })
    expect(container.querySelector('[data-cpu-preview-banner]')).toBeNull()
    expect(container.querySelector('[data-raw-preview-frame]')).not.toBeNull()
    expect(useCpuPreview).not.toHaveBeenCalled()
  })
})
