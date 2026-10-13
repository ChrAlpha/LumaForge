import { NEUTRAL_SELECTIVE_COLOR } from '@lumaforge/luma-color-runtime'
import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi } from 'vitest'

import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawProcessorView } from '../RawProcessorView'

const mockUseRawWorkflow = vi.hoisted(() => vi.fn())
const mockUseCapabilityGate = vi.hoisted(() => vi.fn())

vi.mock('../hooks/useRawWorkflow', () => ({
  useRawWorkflow: mockUseRawWorkflow,
}))

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: mockUseCapabilityGate,
}))

const DOTTED_DECODER_EXTENSIONS = new Set(
  Array.from(SUPPORTED_RAW_EXTENSIONS, (extension) => `.${extension}`),
)

function rawProcessorViewState(
  overrides: Partial<UseRawWorkflowReturn> = {},
): UseRawWorkflowReturn {
  return {
    params: {
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
      intensity: 0.7,
      styleKind: 'none',
      builtinPreset: null,
      selectiveColor: NEUTRAL_SELECTIVE_COLOR,
    },
    loadedImage: { file: null, metadata: null },
    decodedImageRef: { current: null },
    decodedImageVersion: 0,
    decodedFrame: null,
    status: 'idle',
    error: null,
    progress: 0,
    lutData: null,
    lutDataRef: { current: null },
    lutDataVersion: 0,
    previewFacts: null,
    hasImage: false,
    canExport: false,
    exportRefusal: { code: 'source-loading' },
    canPreviewExport: false,
    previewExportRefusal: 'hq-preview-pending',
    exportResult: null,
    exportShareCapability: {
      available: false,
      reasonCode: 'no-result',
    },
    exportInterrupted: false,
    activeStyle: null,
    lutProfileSelection: null,
    viewMode: 'compare',
    compareSplit: 0.5,
    currentLutName: null,
    sourceFileName: '',
    supportLevel: 'experimental',
    progressRecoveryHint: undefined,
    embeddedPreviewUrl: null,
    displaySource: 'none',
    originalReferenceSnapshot: null,
    originalReferenceFallbackReason: null,
    dualGpuAllowed: false,
    previewSuspended: false,
    loadFile: vi.fn(),
    loadLUT: vi.fn(),
    loadOnlineLUT: vi.fn(),
    selectLUTProfile: vi.fn(),
    setIntensity: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    resetCompareView: vi.fn(),
    clearLUT: vi.fn(),
    setToneParams: vi.fn(),
    setColorParams: vi.fn(),
    resetTone: vi.fn(),
    resetColor: vi.fn(),
    setSelectiveColorBand: vi.fn(),
    resetSelectiveColor: vi.fn(),
    exportImage: vi.fn(),
    exportPreviewImage: vi.fn(),
    downloadExportResult: vi.fn(),
    downloadExportManifest: vi.fn(),
    shareExportResult: vi.fn(),
    copyExportResult: vi.fn(),
    restorePreviewAfterExport: vi.fn(),
    requestOriginalReferenceFallback: vi.fn(),
    setOriginalPreviewPipeline: vi.fn(),
    reset: vi.fn(),
    dismissError: vi.fn(),
    updateStats: vi.fn(),
    pipelineRef: { current: null },
    rawRuntimeHost: createRawRuntimeHost(),
    transform: { state: null, dispatch: vi.fn() },
    ...overrides,
    previewViewport: overrides.previewViewport ?? {
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    setPreviewViewport: overrides.setPreviewViewport ?? vi.fn(),
  }
}

vi.mock('~/lib/webgpu/raw-processing-pipeline', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('~/lib/webgpu/raw-processing-pipeline')
    >()

  return {
    ...actual,
    RawProcessingPipeline: class {
      async initialize() {}
      async waitForGpu() {}
      resize() {}
      uploadImage() {}
      clearImage() {}
      uploadLUT() {}
      clearLUT() {}
      setParams() {}
      render() {
        return {
          renderTime: 0,
          memoryUsage: 0,
          textureSize: { width: 0, height: 0 },
        }
      }
      dispose() {}
      onDisposed() {
        return () => {}
      }
    },
  }
})

beforeEach(() => {
  mockUseCapabilityGate.mockReturnValue({
    ready: true,
    supportStatus: 'supported',
    reason: null,
  })

  vi.stubGlobal('CSS', {
    supports: vi.fn(() => true),
  })

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('rawProcessorView', () => {
  it('syncs RAW engine warmup state into the empty first screen', async () => {
    // A warmup that never settles keeps the workflow's host pending.
    const rawRuntimeHost = createRawRuntimeHost({
      runtimeFactory: () =>
        ({
          init: () => new Promise(() => {}),
          openSession: vi.fn(),
          dispose: vi.fn(),
        }) satisfies LumaRawRuntime,
    })
    void rawRuntimeHost.prewarm()
    mockUseRawWorkflow.mockReturnValue(
      rawProcessorViewState({ rawRuntimeHost }),
    )

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    expect(screen.getByText('Waking RAW engine')).toBeInTheDocument()
    expect(
      screen.getByText(
        'You can choose a file now; processing starts after the engine is ready.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /finish a raw with a lut/i }),
    ).toBeEnabled()
  })

  it('gives every RAW file input the decoder extension set', async () => {
    mockUseRawWorkflow.mockReturnValue(rawProcessorViewState())

    let container!: HTMLElement
    await act(async () => {
      ;({ container } = render(<RawProcessorView />))
      await Promise.resolve()
    })

    const rawInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).filter((input) => input.accept !== '.cube')

    // Stage dropzone plus the replace picker; there is no recovery-only one.
    expect(rawInputs).toHaveLength(2)
    for (const input of rawInputs) {
      expect(new Set(input.accept.split(','))).toEqual(
        DOTTED_DECODER_EXTENSIONS,
      )
    }
  })

  it('requires confirmation before resetting the RAW session', async () => {
    const user = userEvent.setup()
    const reset = vi.fn()
    mockUseRawWorkflow.mockReturnValue(
      rawProcessorViewState({
        hasImage: true,
        sourceFileName: 'DSC09142.ARW',
        reset,
      }),
    )

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', {
        name: 'Reset',
      }),
    )

    expect(reset).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog', {
      name: 'Reset session',
    })
    expect(dialog).toBeInTheDocument()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(reset).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('alertdialog', { name: 'Reset session' }),
    ).not.toBeInTheDocument()

    await user.click(
      within(screen.getByRole('banner')).getByRole('button', {
        name: 'Reset',
      }),
    )
    await user.click(
      within(
        screen.getByRole('alertdialog', { name: 'Reset session' }),
      ).getByRole('button', { name: 'Reset session' }),
    )

    expect(reset).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('alertdialog', { name: 'Reset session' }),
    ).not.toBeInTheDocument()
  })

  it('renders Chinese Raw Lab shell when the persisted locale is Chinese', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    mockUseRawWorkflow.mockReturnValue(rawProcessorViewState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    expect(screen.getByText('LumaForge RAW Lab')).toBeInTheDocument()
    expect(
      screen.getByText('拖入一张 RAW，在本机预览、对比、定稿并导出。'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择 RAW' })).toBeEnabled()
    expect(
      screen.getByRole('complementary', { name: 'RAW 成片控制项' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '导出' })).toBeInTheDocument()
    expect(screen.getByText('未处理 RAW')).toBeInTheDocument()
    expect(screen.getByText('最终 JPEG')).toBeInTheDocument()
  })
})
