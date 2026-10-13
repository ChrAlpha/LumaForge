import {
  NEUTRAL_SELECTIVE_COLOR,
  pickColorGraphIntent,
} from '@lumaforge/luma-color-runtime'
import type { LumaRawRuntime } from '@lumaforge/luma-raw-runtime'
import type { RenderResult } from '@testing-library/react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'jotai'
import type { ComponentProps, ReactElement } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import { viewportWidthAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'
import { SUPPORTED_RAW_EXTENSIONS } from '~/lib/raw/decoder'
import { createRawRuntimeHost } from '~/lib/raw/raw-runtime-host'

import { ComparePreviewStage } from '../components/ComparePreviewStage'
import { LutDropzone } from '../components/Dropzone'
import { PreviewCanvas } from '../components/PreviewCanvas'
import type { RawToolSurfaceFixtureProps } from '../components/raw-tool-surface.fixture'
import { renderRawToolSurface } from '../components/raw-tool-surface.fixture'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawProcessorView } from '../RawProcessorView'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'

const mockUseRawWorkflow = vi.hoisted(() => vi.fn())
const mockUseCapabilityGate = vi.hoisted(() => vi.fn())

vi.mock('../hooks', () => ({
  useRawWorkflow: mockUseRawWorkflow,
}))

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: mockUseCapabilityGate,
}))

const DOTTED_DECODER_EXTENSIONS = new Set(
  Array.from(SUPPORTED_RAW_EXTENSIONS, (extension) => `.${extension}`),
)

function rawToolSurfaceProps(
  overrides: RawToolSurfaceFixtureProps = {},
): RawToolSurfaceFixtureProps {
  return {
    activeIntensity: 0.7,
    tone: {
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
    },
    color: {
      userTemperature: 0,
      userTint: 0,
      userSaturation: 0,
      userVibrance: 0,
    },
    onIntensityChange: () => {},
    onToneChange: () => {},
    onToneReset: () => {},
    onColorChange: () => {},
    onColorReset: () => {},
    onSelectiveColorChange: () => {},
    onSelectiveColorReset: () => {},
    onCompareReset: () => {},
    viewMode: 'processed',
    onViewModeChange: () => {},
    onCompareSplitChange: () => {},
    fileName: 'DSC09142.ARW',
    onReplaceFile: () => {},
    onResetSession: () => {},
    onLutLoad: () => {},
    onLutClear: () => {},
    onLutProfileSelect: () => {},
    onExport: () => {},
    canExport: false,
    disabledReason: { source: 'workflow', reason: { code: 'source-loading' } },
    isProcessing: false,
    exportResult: null,
    exportShareCapability: {
      available: false,
      reasonCode: 'no-result',
    },
    onShareExport: () => {},
    onDownloadExport: () => {},
    onCopyExport: () => {},
    hasImage: true,
    currentLutName: null,
    lutProfileSelection: null,
    lutProfileResolution: null,
    supportLevel: 'experimental',
    metadata: null,
    stats: null,
    histogram: { state: 'unavailable' as const, reason: 'no-image' as const },
    ...overrides,
  }
}

const stageColor = pickColorGraphIntent({
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
  selectiveColor: NEUTRAL_SELECTIVE_COLOR,
  intensity: 0.7,
  styleKind: 'none',
  builtinPreset: null,
})

/** Renders inside act, so the mocked preview pipelines finish initializing. */
async function renderSettled(ui: ReactElement): Promise<RenderResult> {
  let rendered!: RenderResult
  await act(async () => {
    rendered = render(ui)
  })
  return rendered
}

function compareStageProps(
  overrides: Partial<ComponentProps<typeof ComparePreviewStage>> = {},
): ComponentProps<typeof ComparePreviewStage> {
  return {
    hasImage: false,
    imageRef: { current: null },
    imageVersion: 0,
    decodedFrame: null,
    color: stageColor,
    viewMode: 'compare',
    lutDataRef: { current: null },
    lutDataVersion: 0,
    embeddedPreviewUrl: null,
    displaySource: 'none',
    split: 0.5,
    onSplitChange: () => {},
    isProcessing: false,
    phase: 'loading',
    progress: 0,
    onRawDrop: () => {},
    ...overrides,
  }
}

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
    setParams: vi.fn(),
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
          probe: vi.fn(),
          extractEmbeddedPreview: vi.fn(),
          decodeQuick: vi.fn(),
          decodeBoundedHq: vi.fn(),
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

  it('passes hook histogram state into RAW tools with Histogram', async () => {
    const user = userEvent.setup()
    mockUseRawWorkflow.mockReturnValue(rawProcessorViewState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    await user.click(screen.getByRole('button', { name: 'Histogram' }))
    expect(
      screen.getAllByRole('region', { name: 'Histogram' }).length,
    ).toBeGreaterThanOrEqual(1)
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

  it('keeps mobile reset confirmation in the dark on-photo design language', async () => {
    const user = userEvent.setup()
    const prevViewport = jotaiStore.get(viewportWidthAtom)
    const reset = vi.fn()
    jotaiStore.set(viewportWidthAtom, 390)
    mockUseRawWorkflow.mockReturnValue(
      rawProcessorViewState({
        hasImage: true,
        sourceFileName: 'DSC09142.ARW',
        reset,
      }),
    )

    try {
      await act(async () => {
        render(
          <Provider store={jotaiStore}>
            <RawProcessorView />
          </Provider>,
        )
        await Promise.resolve()
      })

      await user.click(screen.getByRole('button', { name: 'More actions' }))
      await user.click(
        await screen.findByRole('menuitem', { name: 'Reset session' }),
      )

      const dialog = screen.getByRole('alertdialog', {
        name: 'Reset session',
      })
      expect(dialog).toHaveAttribute('data-mobile-substrate', 'ink-sheet')
      expect(dialog).toHaveClass('bg-gradient-to-t')
      expect(dialog).toHaveClass('from-[oklch(0.092_0.006_255/0.96)]')
      expect(dialog).not.toHaveClass('from-black/92')
      expect(dialog).not.toHaveClass('to-lf-darkroom-stage-low/94')
      expect(dialog).toHaveClass('text-lf-on-photo-ink')
      expect(dialog).toHaveClass('border-lf-on-photo-bord-soft')
      expect(dialog).not.toHaveClass('bg-lf-surface-raised')
      expect(dialog).not.toHaveClass('text-lf-on-surface')
      expect(
        dialog.querySelector('[data-raw-reset-confirm-actions]'),
      ).toHaveClass('bg-[oklch(0.064_0.006_255/0.92)]')
      expect(
        dialog.querySelector('[data-raw-reset-confirm-actions]'),
      ).not.toHaveClass('bg-lf-surface-muted/60')
      expect(
        dialog.querySelector('[data-raw-reset-confirm-actions]'),
      ).not.toHaveClass('bg-lf-on-photo-bg')

      // Desktop sm: overrides must also stay in the workspace chrome
      // language. The dialog renders in a Portal so it escapes the
      // .raw-lab scoping, so a generic chrome surface like
      // sm:bg-lf-surface-raised resolves to the @theme token (now dark
      // slate; formerly the warm-paper value) instead of the on-photo
      // material the dialog needs. Encode the no-leak contract: the sm:
      // class set must NOT include a generic surface variant, and MUST
      // include the on-photo bord-soft hairline.
      expect(dialog).not.toHaveClass('sm:bg-lf-surface-raised')
      expect(dialog).not.toHaveClass('sm:text-lf-on-surface')
      expect(dialog).not.toHaveClass('sm:border-border-secondary')
      expect(dialog).not.toHaveClass('sm:shadow-lf-popover')
      expect(dialog).toHaveClass('sm:border-lf-on-photo-bord-soft')
      expect(dialog).toHaveClass('sm:text-lf-on-photo-ink')
      const desktopActionsRow = dialog.querySelector(
        '[data-raw-reset-confirm-actions]',
      )
      expect(desktopActionsRow).not.toHaveClass('sm:bg-lf-surface-muted/60')
      expect(desktopActionsRow).not.toHaveClass('sm:border-border-secondary')
      expect(desktopActionsRow).toHaveClass('sm:border-lf-on-photo-bord-soft')
    } finally {
      // The view unmounts before the viewport is restored, so the restore
      // re-renders nothing.
      cleanup()
      jotaiStore.set(viewportWidthAtom, prevViewport)
    }
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

  it('renders header actions as accessible buttons', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    mockUseRawWorkflow.mockReturnValue(rawProcessorViewState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    expect(screen.getByRole('button', { name: '选择 RAW' })).toBeInTheDocument()
  })
})

describe('rawToolSurface', () => {
  it('presents task-grouped RAW tools with Histogram', () => {
    renderRawToolSurface(rawToolSurfaceProps())

    expect(
      screen.getAllByRole('region', { name: 'LUT contract' }).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getAllByRole('region', { name: 'Adjust' }).length,
    ).toBeGreaterThanOrEqual(1)
    // Strength is now inside the Look card, no longer a standalone region
    expect(
      screen.queryByRole('region', { name: 'JPEG presets' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Neutral' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Strength' })).toBeInTheDocument()
    expect(screen.getByLabelText('Exposure')).toBeInTheDocument()
    expect(screen.queryByText('Log Space')).not.toBeInTheDocument()
  })

  it('keeps LUT loading available before upload without JPEG presets', () => {
    renderRawToolSurface(rawToolSurfaceProps({ hasImage: false }))

    expect(
      screen.queryByRole('region', { name: 'JPEG presets' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Neutral' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Warm' }),
    ).not.toBeInTheDocument()
    expect(screen.getByLabelText(/add \.cube lut/i)).toBeEnabled()
  })

  it('keeps LUT upload backed by a native file input for mobile tap upload', () => {
    const onFileDrop = vi.fn()
    const file = new File(['lut'], 'look.cube', {
      type: 'application/octet-stream',
    })

    render(<LutDropzone onFileDrop={onFileDrop} />)

    const input = screen.getByLabelText(/add \.cube lut/i)
    expect(input).toHaveAttribute('type', 'file')
    expect(input).toHaveAttribute('accept', '.cube')
    expect(input).not.toBeDisabled()

    fireEvent.change(input, {
      target: {
        files: [file],
      },
    })

    expect(onFileDrop).toHaveBeenCalledWith([file])
  })

  it('shows hook-provided export disabled reason in the export controls', () => {
    renderRawToolSurface(
      rawToolSurfaceProps({
        disabledReason: {
          source: 'workflow',
          reason: { code: 'exposure-pending' },
        },
      }),
    )

    expect(
      screen.getByText('RAW preview exposure is still being prepared.'),
    ).toBeInTheDocument()
  })

  it('keeps compare copy tied to the new split interaction', async () => {
    const user = userEvent.setup()
    renderRawToolSurface(rawToolSurfaceProps())

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    expect(
      screen.getAllByRole('region', { name: 'Compare' }).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getByText('Drag the split directly on the image.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Processed' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Original' }),
    ).not.toBeInTheDocument()
  })

  it('lets users reset the compare split while already comparing', async () => {
    const user = userEvent.setup()
    const onCompareReset = vi.fn()

    renderRawToolSurface(
      rawToolSurfaceProps({
        onCompareReset,
      }),
    )

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    const resetButton = screen.getByRole('button', {
      name: 'Reset compare view',
    })
    expect(resetButton).toBeEnabled()

    await user.click(resetButton)

    expect(onCompareReset).toHaveBeenCalledTimes(1)
  })

  it('keeps loaded preview stage drop-only instead of a button target', async () => {
    const user = userEvent.setup()
    const onRawDrop = vi.fn()
    const file = new File(['raw'], 'photo.dng', {
      type: 'image/x-adobe-dng',
    })

    const { container } = render(
      <ComparePreviewStage
        hasImage
        imageRef={{ current: null }}
        imageVersion={0}
        decodedFrame={null}
        color={stageColor}
        viewMode="processed"
        lutDataRef={{ current: null }}
        lutDataVersion={0}
        split={0.5}
        isProcessing={false}
        phase="processing"
        progress={0}
        onRawDrop={onRawDrop}
        onSplitChange={() => {}}
      />,
    )

    const stageFrame = container.querySelector('.raw-lab-stage-frame')
    expect(
      screen.queryByRole('button', { name: 'Replace RAW file' }),
    ).not.toBeInTheDocument()
    expect(stageFrame).not.toHaveAttribute('tabindex')
    expect(stageFrame).toHaveClass('cursor-default')

    const input = document.createElement('input')
    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {})
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(input)

    await user.click(stageFrame!)

    expect(createElement).not.toHaveBeenCalled()
    expect(inputClick).not.toHaveBeenCalled()

    fireEvent.drop(stageFrame!, {
      dataTransfer: {
        files: [file],
      },
    })

    expect(onRawDrop).toHaveBeenCalledWith([file])
  })

  it('keeps preview stage focus visually neutral', async () => {
    const { container } = await renderSettled(
      <ComparePreviewStage
        {...compareStageProps({
          hasImage: true,
          phase: 'processing',
        })}
      />,
    )

    const stageFrame = container.querySelector('.raw-lab-stage-frame')
    expect(stageFrame).toHaveClass('focus-within:ring-0')
    expect(stageFrame).toHaveClass('focus-visible:ring-0')
    expect(stageFrame).not.toHaveClass('focus-within:ring-accent')
    expect(stageFrame).not.toHaveClass('focus-visible:ring-accent')
  })

  it('uses a neutral preview mat instead of a black preview background', async () => {
    const { container } = await renderSettled(
      <ComparePreviewStage
        {...compareStageProps({
          hasImage: true,
          phase: 'processing',
        })}
      />,
    )

    const previewFrame = container.querySelector('[data-raw-preview-frame]')
    expect(previewFrame).toHaveClass('bg-[var(--color-preview-mat)]')
    expect(previewFrame).not.toHaveClass('bg-black/20')
  })

  it('keeps empty preview stage upload button separate from the compare slider', async () => {
    const user = userEvent.setup()

    const { container } = render(
      <ComparePreviewStage
        hasImage={false}
        imageRef={{ current: null }}
        imageVersion={0}
        decodedFrame={null}
        color={stageColor}
        viewMode="processed"
        lutDataRef={{ current: null }}
        lutDataVersion={0}
        split={0.5}
        isProcessing={false}
        phase="processing"
        progress={0}
        onRawDrop={() => {}}
        onSplitChange={() => {}}
      />,
    )

    const stageFrame = container.querySelector('.raw-lab-stage-frame')
    const uploadButton = screen.getByRole('button', {
      name: /finish a raw with a lut/i,
    })
    const compareSlider = screen.getByRole('slider', {
      name: 'Compare unprocessed RAW and final JPEG',
    })

    expect(stageFrame).not.toHaveAttribute('tabindex')
    expect(
      screen.queryByRole('button', { name: 'Load RAW file' }),
    ).not.toBeInTheDocument()
    expect(uploadButton).toHaveAttribute('data-raw-upload-dock')
    expect(uploadButton).not.toContainElement(compareSlider)
    expect(stageFrame).toContainElement(uploadButton)
    expect(stageFrame).toContainElement(compareSlider)

    const fileInput =
      stageFrame?.querySelector<HTMLInputElement>('input[type="file"]')
    expect(fileInput).toBeTruthy()
    expect(fileInput).toHaveAttribute('aria-hidden', 'true')
    expect(new Set(fileInput!.accept.split(','))).toEqual(
      DOTTED_DECODER_EXTENSIONS,
    )
    const inputClick = vi
      .spyOn(fileInput!, 'click')
      .mockImplementation(() => {})

    await user.click(uploadButton)

    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  describe('comparePreviewStage', () => {
    it('places upload inside the empty compare stage', () => {
      const { container } = render(
        <ComparePreviewStage {...compareStageProps()} />,
      )

      const stage = screen.getByLabelText('RAW preview comparison')
      const uploadButton = screen.getByRole('button', {
        name: /finish a raw with a lut/i,
      })
      const sample = container.querySelector<HTMLElement>('.raw-lab-sample')

      expect(stage).toBeInTheDocument()
      expect(stage).toContainElement(uploadButton)
      expect(sample?.style.getPropertyValue('--raw-compare-split')).toBe('')
      expect(
        sample?.style.getPropertyValue('--raw-compare-split-committed'),
      ).toBe('50%')
      expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
      expect(screen.getByText('Final JPEG')).toBeInTheDocument()
      expect(
        screen.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toBeInTheDocument()
    })

    it('shows RAW engine readiness without blocking the empty upload action', () => {
      render(
        <ComparePreviewStage
          {...compareStageProps({ runtimeReadinessState: 'pending' })}
        />,
      )

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

    it('updates the empty upload copy once the RAW engine is ready', () => {
      render(
        <ComparePreviewStage
          {...compareStageProps({ runtimeReadinessState: 'ready' })}
        />,
      )

      expect(screen.getByText('RAW engine ready')).toBeInTheDocument()
      expect(
        screen.getByText('Choose a RAW and processing can start immediately.'),
      ).toBeInTheDocument()
    })

    it('renders a legible progress indicator without relying on spin motion', () => {
      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            isProcessing: true,
            phase: 'decoding',
            progress: 50,
          })}
        />,
      )

      const indicator = container.querySelector('[data-progress-indicator]')
      const arc = container.querySelector('[data-progress-arc]')

      expect(indicator).toBeInTheDocument()
      expect(indicator).toHaveClass('size-full')
      expect(indicator).not.toHaveClass('animate-spin')
      expect(arc).toHaveAttribute('stroke-dasharray', '100')
      expect(arc).toHaveAttribute('stroke-dashoffset', '50')
      expect(arc).toHaveAttribute('stroke', 'var(--color-progress)')
      expect(screen.getByText('50%')).toHaveClass(
        'text-[var(--color-on-stage)]',
      )
    })

    it('keeps compare labels when an image is loaded', async () => {
      await act(async () => {
        render(
          <ComparePreviewStage
            {...compareStageProps({
              hasImage: true,
              dualGpuAllowed: true,
              imageRef: {
                current: {
                  data: new Uint16Array(3),
                  width: 1,
                  height: 1,
                  channels: 3,
                  bitsPerChannel: 16,
                  layout: 'rgb-u16',
                  colorSpace: 'linear-prophoto-rgb',
                  metadata: { width: 1, height: 1 },
                  renderExposure: {
                    ev: 0,
                    multiplier: 1,
                    source: 'identity',
                  },
                },
              },
            })}
          />,
        )
      })

      expect(
        screen.queryByRole('button', { name: /finish a raw with a lut/i }),
      ).not.toBeInTheDocument()
      expect(
        screen.queryByText('Finish a RAW with a LUT'),
      ).not.toBeInTheDocument()
      expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
      expect(screen.getByText('Final JPEG')).toBeInTheDocument()
      expect(
        screen.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toBeInTheDocument()
    })

    it('keeps compare controls mounted while compare rendering is temporarily processed-only', async () => {
      await act(async () => {
        render(
          <ComparePreviewStage
            {...compareStageProps({
              hasImage: true,
              dualGpuAllowed: false,
              originalReferenceSnapshot: null,
              imageRef: {
                current: {
                  data: new Uint16Array(3),
                  width: 1,
                  height: 1,
                  channels: 3,
                  bitsPerChannel: 16,
                  layout: 'rgb-u16',
                  colorSpace: 'linear-prophoto-rgb',
                  metadata: { width: 1, height: 1 },
                  renderExposure: {
                    ev: 0,
                    multiplier: 1,
                    source: 'identity',
                  },
                },
              },
            })}
          />,
        )
      })

      expect(
        screen.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toBeInTheDocument()
      expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
      expect(screen.getByText('Final JPEG')).toBeInTheDocument()
    })

    it('keeps compare controls mounted when CSS clipping disables snapshot compare', async () => {
      vi.stubGlobal('CSS', {
        supports: vi.fn(() => false),
      })

      const snapshot: OriginalReferenceSnapshot = {
        key: 'original-reference|session:test',
        objectUrl: 'blob:original-reference',
        width: 1,
        height: 1,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 512,
      }

      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            dualGpuAllowed: false,
            originalReferenceSnapshot: snapshot,
            imageRef: {
              current: {
                data: new Uint16Array(3),
                width: 1,
                height: 1,
                channels: 3,
                bitsPerChannel: 16,
                layout: 'rgb-u16',
                colorSpace: 'linear-prophoto-rgb',
                metadata: { width: 1, height: 1 },
                renderExposure: {
                  ev: 0,
                  multiplier: 1,
                  source: 'identity',
                },
              },
            },
          })}
        />,
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(
        container.querySelector('[data-compare-mode="processed-only"]'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toBeInTheDocument()
      expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
      expect(screen.getByText('Final JPEG')).toBeInTheDocument()
    })

    it('threads dual-gpu compare DOM into the loaded preview surface', async () => {
      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            dualGpuAllowed: true,
            imageVersion: 1,
            decodedFrame: {
              sessionId: 'session-1',
              frameId: 'decoded-frame-1',
              stage: 'quick',
              width: 1,
              height: 1,
              exposure: {
                kind: 'unpinned',
                value: { ev: 0, multiplier: 1, source: 'identity' },
              },
              quickPredecessorFrameId: null,
            },
            imageRef: {
              current: {
                data: new Uint16Array(3),
                width: 1,
                height: 1,
                channels: 3,
                bitsPerChannel: 16,
                layout: 'rgb-u16',
                colorSpace: 'linear-prophoto-rgb',
                metadata: { width: 1, height: 1 },
                renderExposure: {
                  ev: 0,
                  multiplier: 1,
                  source: 'identity',
                },
              },
            },
          })}
        />,
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(
        container.querySelector('[data-compare-mode="dual-gpu"]'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('.raw-preview-original-gpu-layer'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('.raw-preview-processed-layer'),
      ).toHaveClass('raw-preview-layer-clipped')
    })

    it('threads jpeg fallback compare DOM into the loaded preview surface', async () => {
      const snapshot: OriginalReferenceSnapshot = {
        key: 'original-reference|session:test',
        objectUrl: 'blob:original-reference',
        width: 1,
        height: 1,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 512,
      }

      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            dualGpuAllowed: false,
            originalReferenceSnapshot: snapshot,
            imageRef: {
              current: {
                data: new Uint16Array(3),
                width: 1,
                height: 1,
                channels: 3,
                bitsPerChannel: 16,
                layout: 'rgb-u16',
                colorSpace: 'linear-prophoto-rgb',
                metadata: { width: 1, height: 1 },
                renderExposure: {
                  ev: 0,
                  multiplier: 1,
                  source: 'identity',
                },
              },
            },
          })}
        />,
      )

      await act(async () => {
        await Promise.resolve()
      })

      expect(
        container.querySelector('[data-compare-mode="jpeg-fallback"]'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('.raw-preview-original-layer img'),
      ).toHaveAttribute('src', 'blob:original-reference')
      expect(
        container.querySelector('.raw-preview-processed-layer'),
      ).toHaveClass('raw-preview-layer-clipped')
    })

    it('threads original reference compare state through the real RAW view', async () => {
      const snapshot: OriginalReferenceSnapshot = {
        key: 'original-reference|session:test',
        objectUrl: 'blob:original-reference',
        width: 1,
        height: 1,
        source: 'quick',
        mimeType: 'image/jpeg',
        estimatedBytes: 512,
      }

      mockUseRawWorkflow.mockReturnValue({
        ...rawProcessorViewState({
          hasImage: true,
          decodedImageRef: {
            current: {
              data: new Uint16Array(3),
              width: 1,
              height: 1,
              channels: 3,
              bitsPerChannel: 16,
              layout: 'rgb-u16',
              colorSpace: 'linear-prophoto-rgb',
              metadata: { width: 1, height: 1 },
              renderExposure: {
                ev: 0,
                multiplier: 1,
                source: 'identity',
              },
            },
          },
        }),
        dualGpuAllowed: false,
        originalReferenceSnapshot: snapshot,
        originalReferenceFallbackReason: null,
      })

      const { container } = render(<RawProcessorView />)

      await act(async () => {
        await Promise.resolve()
      })

      expect(
        container.querySelector('[data-compare-mode="jpeg-fallback"]'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('.raw-preview-original-layer img'),
      ).toHaveAttribute('src', 'blob:original-reference')
    })

    it('can hide the split comparison affordance for mobile hold-to-peek mode', async () => {
      await act(async () => {
        render(
          <ComparePreviewStage
            {...compareStageProps({
              hasImage: true,
              splitEnabled: false,
              imageRef: {
                current: {
                  data: new Uint16Array(3),
                  width: 1,
                  height: 1,
                  channels: 3,
                  bitsPerChannel: 16,
                  layout: 'rgb-u16',
                  colorSpace: 'linear-prophoto-rgb',
                  metadata: { width: 1, height: 1 },
                  renderExposure: {
                    ev: 0,
                    multiplier: 1,
                    source: 'identity',
                  },
                },
              },
            })}
          />,
        )
      })

      expect(
        screen.queryByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Unprocessed RAW')).not.toBeInTheDocument()
      expect(screen.queryByText('Final JPEG')).not.toBeInTheDocument()
    })

    it('hides compare controls during a memory-safe export handoff', async () => {
      await act(async () => {
        render(
          <ComparePreviewStage
            {...compareStageProps({
              hasImage: true,
              isProcessing: true,
              phase: 'exporting',
              previewSuspended: true,
              imageRef: {
                current: {
                  data: new Uint16Array(3),
                  width: 1,
                  height: 1,
                  channels: 3,
                  bitsPerChannel: 16,
                  layout: 'rgb-u16',
                  colorSpace: 'linear-prophoto-rgb',
                  metadata: { width: 1, height: 1 },
                  renderExposure: {
                    ev: 0,
                    multiplier: 1,
                    source: 'identity',
                  },
                },
              },
            })}
          />,
        )
      })

      expect(
        screen.queryByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Unprocessed RAW')).not.toBeInTheDocument()
      expect(screen.queryByText('Final JPEG')).not.toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveAttribute(
        'data-progress-overlay',
        'exporting',
      )
    })

    it('keeps the evacuated export transition on a dark flat stage instead of an empty preview', async () => {
      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            isProcessing: true,
            phase: 'exporting',
            previewSuspended: true,
            imageRef: { current: null },
          })}
        />,
      )

      const stage = container.querySelector('.raw-lab-stage')
      const stageFrame = container.querySelector('.raw-lab-stage-frame')
      expect(stage).toHaveAttribute('data-preview-state', 'exporting-released')
      expect(stageFrame).not.toHaveClass('opacity-50')
      expect(
        container.querySelector('[data-raw-export-processing-handoff]'),
      ).toBeInTheDocument()
      expect(screen.queryByText('No image loaded')).not.toBeInTheDocument()
    })

    it('keeps preview restore on the same flat dark handoff after evacuation', async () => {
      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            isProcessing: true,
            phase: 'decoding',
            previewSuspended: true,
            imageRef: { current: null },
          })}
        />,
      )

      expect(container.querySelector('.raw-lab-stage')).toHaveAttribute(
        'data-preview-state',
        'restoring-released',
      )
      expect(
        container.querySelector('[data-raw-export-processing-handoff]'),
      ).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveAttribute(
        'data-progress-variant',
        'flat-handoff',
      )
      expect(screen.queryByText('No image loaded')).not.toBeInTheDocument()
    })

    it('keeps a ready export handoff instead of showing an empty preview after evacuation', async () => {
      const onRestorePreview = vi.fn()
      await act(async () => {
        render(
          <ComparePreviewStage
            {...({
              ...compareStageProps({
                hasImage: true,
                isProcessing: false,
                phase: 'processing',
                previewSuspended: true,
                imageRef: { current: null },
              }),
              onRestorePreview,
            } as ComponentProps<typeof ComparePreviewStage> & {
              onRestorePreview: () => void
            })}
          />,
        )
      })

      expect(screen.queryByText('No image loaded')).not.toBeInTheDocument()
      expect(screen.getByText('JPEG ready')).toBeInTheDocument()
      expect(
        screen.getByText(
          'Preview remains released so the browser can keep the full-resolution result stable.',
        ),
      ).toBeInTheDocument()

      await userEvent.click(
        screen.getByRole('button', { name: 'Restore preview' }),
      )

      expect(onRestorePreview).toHaveBeenCalledTimes(1)
    })
  })

  it('shows an embedded RAW preview image before decoded pixels are ready', async () => {
    await act(async () => {
      render(
        <PreviewCanvas
          imageRef={{ current: null }}
          imageVersion={0}
          decodedFrame={null}
          color={stageColor}
          viewMode="processed"
          lutDataRef={{ current: null }}
          lutDataVersion={0}
          embeddedPreviewUrl="blob:embedded-preview"
          displaySource="embedded"
        />,
      )
      await Promise.resolve()
    })

    const image = screen.getByAltText('Embedded RAW preview')
    expect(image).toHaveAttribute('src', 'blob:embedded-preview')
    expect(screen.queryByText('No image loaded')).not.toBeInTheDocument()
  })
})
