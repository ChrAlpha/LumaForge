import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawProcessorView } from '../RawProcessorView'

const mockUseRawWorkflow = vi.hoisted(() => vi.fn())
const mockUseCapabilityGate = vi.hoisted(() => vi.fn())

vi.mock('../hooks', () => ({
  useRawWorkflow: mockUseRawWorkflow,
}))

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: mockUseCapabilityGate,
}))

vi.mock('~/lib/gl/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/gl/pipeline')>()

  return {
    ...actual,
    RawProcessingPipeline: class {
      async initialize() {}
      resize() {}
      uploadImage() {}
      clearImage() {}
      uploadLUT() {}
      clearLUT() {}
      setParams() {}
      render() {
        return {
          uploadTime: 0,
          lutUploadTime: 0,
          processTime: 0,
          totalTime: 0,
          inputSize: { width: 0, height: 0 },
          previewSize: { width: 0, height: 0 },
          inputFormat: 'uint16-rgb',
          transformPath: 'no-lut',
          lutRole: null,
          lutInputTransfer: null,
          lutOutputTransfer: null,
          lutSize: null,
          processTargetPrecision: 'rgba16f',
          capabilityWarnings: [],
        }
      }
      dispose() {}
    },
  }
})

function valueForFact(region: HTMLElement, label: string) {
  const term = Array.from(region.querySelectorAll('dt')).find(
    (element) => element.textContent === label,
  )
  expect(term).toBeInTheDocument()
  const value = term?.nextElementSibling
  expect(value?.tagName).toBe('DD')
  return value as HTMLElement
}

function createLoadedProcessorState(
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
      viewMode: 'compare',
      compareSplit: 0.5,
      styleKind: 'none',
      builtinPreset: null,
    },
    loadedImage: {
      file: new File(['raw'], 'frame.ARW'),
      metadata: {
        make: 'Sony',
        model: 'A7R',
        width: 6048,
        height: 4024,
      },
    },
    decodedImageRef: {
      current: {
        width: 4000,
        height: 2666,
        channels: 3,
        bitsPerChannel: 16,
        data: new Uint16Array([0, 1024, 65535]),
        layout: 'rgb-u16',
        colorSpace: 'linear-prophoto-rgb',
        source: 'bounded-hq',
        metadata: {
          make: 'Sony',
          model: 'A7R',
          width: 6048,
          height: 4024,
        },
        renderExposure: { ev: 0, multiplier: 1, source: 'identity' },
      },
    },
    decodedImageVersion: 1,
    status: 'ready',
    error: null,
    progress: 100,
    lut: null,
    lutData: null,
    lutDataRef: { current: null },
    lutDataVersion: 0,
    stats: {
      uploadTime: 4,
      lutUploadTime: 0,
      processTime: 18,
      totalTime: 22,
      inputSize: { width: 4000, height: 2666 },
      previewSize: { width: 1200, height: 800 },
      inputFormat: 'uint16-rgb',
      transformPath: 'no-lut',
      lutRole: null,
      lutInputTransfer: null,
      lutOutputTransfer: null,
      lutSize: null,
      processTargetPrecision: 'rgba16f',
      capabilityWarnings: [],
    },
    hasImage: true,
    canExport: true,
    exportDisabledReason: undefined,
    canPreviewExport: true,
    previewExportDisabledReason: undefined,
    exportResult: null,
    exportShareCapability: {
      available: false,
      reason: 'Export a JPEG before sharing.',
    },
    exportRecovery: { status: 'none' },
    activeStyle: null,
    lutProfileSelection: null,
    activeIntensity: 'standard',
    viewMode: 'compare',
    compareSplit: 0.5,
    currentLutName: null,
    sourceFileName: 'frame.ARW',
    supportLevel: 'experimental',
    progressRecoveryHint: undefined,
    embeddedPreviewUrl: null,
    displaySource: 'bounded-hq',
    originalReferenceSnapshot: null,
    originalReferenceFallbackReason: null,
    dualWebglAllowed: false,
    histogram: { state: 'unavailable', reason: 'no-image' },
    previewSuspended: false,
    loadFile: vi.fn(),
    loadLUT: vi.fn(),
    loadOnlineLUT: vi.fn(),
    selectLUTProfile: vi.fn(),
    selectIntensityLevel: vi.fn(),
    setViewMode: vi.fn(),
    setCompareSplit: vi.fn(),
    clearLUT: vi.fn(),
    setParams: vi.fn(),
    setToneParams: vi.fn(),
    resetTone: vi.fn(),
    setColorParams: vi.fn(),
    resetColor: vi.fn(),
    setSelectiveColorBand: vi.fn(),
    resetSelectiveColor: vi.fn(),
    exportImage: vi.fn(),
    exportPreviewImage: vi.fn(),
    recoverInterruptedExport: vi.fn(),
    downloadExportResult: vi.fn(),
    downloadExportManifest: vi.fn(),
    shareExportResult: vi.fn(),
    copyExportResult: vi.fn(),
    requestOriginalReferenceFallback: vi.fn(),
    setOriginalPreviewPipeline: vi.fn(),
    reset: vi.fn(),
    dismissError: vi.fn(),
    updateStats: vi.fn(),
    pipelineRef: { current: null },
    calibrationStage: {
      availableProfiles: [],
      selectedCameraProfileId: null,
      isApplying: false,
      selectCameraProfile: vi.fn().mockResolvedValue({
        applied: false,
        reason: 'skipped' as const,
      }),
    },
    ...overrides,
    previewViewport: overrides.previewViewport ?? {
      zoom: 1,
      panX: 0,
      panY: 0,
      fitMode: 'screen',
    },
    setPreviewViewport: overrides.setPreviewViewport ?? vi.fn(),
    resetPreviewViewport: overrides.resetPreviewViewport ?? vi.fn(),
    restorePreviewAfterExport: overrides.restorePreviewAfterExport ?? vi.fn(),
  }
}

describe('rawProcessorView file facts', () => {
  beforeEach(() => {
    mockUseCapabilityGate.mockReturnValue({
      ready: true,
      supportStatus: 'supported',
      reason: null,
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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps source Size separate from bounded preview dimensions', async () => {
    const user = userEvent.setup()
    mockUseRawWorkflow.mockReturnValue(createLoadedProcessorState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: 'File facts' }))
    const fileFacts = screen.getByRole('region', { name: 'File facts' })
    const sizeValue = valueForFact(fileFacts, 'Size')
    const previewValue = valueForFact(fileFacts, 'Preview')

    expect(sizeValue).toHaveTextContent('6048 x 4024')
    expect(sizeValue).not.toHaveTextContent('4000 x 2666')
    expect(previewValue).toHaveTextContent('4000 x 2666')
  })
})
