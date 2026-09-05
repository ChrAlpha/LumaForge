import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'jotai'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import { viewportAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'

import { ComparePreviewStage } from '../components/ComparePreviewStage'
import { LutDropzone } from '../components/Dropzone'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { RawToolSurface } from '../components/RawToolSurface'
import type { UseRawWorkflowReturn } from '../hooks/useRawWorkflow'
import { RawProcessorView } from '../RawProcessorView'
import type { OriginalReferenceSnapshot } from '../services/compare/original-reference-snapshot'

const mockUseRawWorkflow = vi.hoisted(() => vi.fn())
const mockUseCapabilityGate = vi.hoisted(() => vi.fn())
const mockRawRuntimeAdapter = vi.hoisted(() => ({
  getPrewarmState: vi.fn(),
  prewarm: vi.fn(),
}))

vi.mock('../hooks', () => ({
  useRawWorkflow: mockUseRawWorkflow,
}))

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: mockUseCapabilityGate,
}))

vi.mock('~/lib/raw/runtime-adapter', () => ({
  rawRuntimeAdapter: mockRawRuntimeAdapter,
}))

function rawToolSurfaceProps(
  overrides: Partial<ComponentProps<typeof RawToolSurface>> = {},
): ComponentProps<typeof RawToolSurface> {
  return {
    activeIntensity: 'standard',
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
    onIntensitySelect: () => {},
    onToneChange: () => {},
    onToneReset: () => {},
    onColorChange: () => {},
    onColorReset: () => {},
    onSelectiveColorChange: () => {},
    onSelectiveColorReset: () => {},
    onCompareReset: () => {},
    viewMode: 'processed',
    onViewModeChange: () => {},
    compareSplit: 0.5,
    onCompareSplitChange: () => {},
    fileName: 'DSC09142.ARW',
    onReplaceFile: () => {},
    onResetSession: () => {},
    onLutLoad: () => {},
    onLutClear: () => {},
    onLutProfileSelect: () => {},
    onExport: () => {},
    canExport: false,
    disabledReason: 'Full-resolution export source is still loading.',
    isProcessing: false,
    exportResult: null,
    exportShareCapability: {
      available: false,
      reason: 'Export a JPEG before sharing.',
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

function compareStageProps(
  overrides: Partial<ComponentProps<typeof ComparePreviewStage>> = {},
): ComponentProps<typeof ComparePreviewStage> {
  return {
    hasImage: false,
    imageRef: { current: null },
    imageVersion: 0,
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
      viewMode: 'compare',
      compareSplit: 0.5,
      styleKind: 'none',
      builtinPreset: null,
    },
    loadedImage: { file: null, metadata: null },
    decodedImageRef: { current: null },
    decodedImageVersion: 0,
    status: 'idle',
    error: null,
    progress: 0,
    lut: null,
    lutData: null,
    lutDataRef: { current: null },
    lutDataVersion: 0,
    stats: null,
    hasImage: false,
    canExport: false,
    exportDisabledReason: 'Full-resolution export source is still loading.',
    canPreviewExport: false,
    previewExportDisabledReason:
      'HQ preview export is available after the bounded HQ preview finishes.',
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
    sourceFileName: '',
    supportLevel: 'experimental',
    progressRecoveryHint: undefined,
    embeddedPreviewUrl: null,
    displaySource: 'none',
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
    setColorParams: vi.fn(),
    resetTone: vi.fn(),
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
    restorePreviewAfterExport: vi.fn(),
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
  }
}

function mockTriggerRect(element: HTMLElement, rect: Partial<DOMRect>) {
  return vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    bottom: rect.bottom ?? 64,
    height: rect.height ?? 32,
    left: rect.left ?? 24,
    right: rect.right ?? 56,
    top: rect.top ?? 32,
    width: rect.width ?? 32,
    x: rect.x ?? rect.left ?? 24,
    y: rect.y ?? rect.top ?? 32,
    toJSON: () => ({}),
  } satisfies DOMRect)
}

async function clickOverlayAt(
  x: number,
  y: number,
  elementsAtPoint: Element[] = [],
) {
  const overlay = document.querySelector('[data-raw-lut-browser-overlay]')
  expect(overlay).toBeInTheDocument()
  const previousElementsFromPoint = document.elementsFromPoint
  const elementsFromPoint = vi.fn(() => [
    overlay as Element,
    ...elementsAtPoint,
  ])
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: elementsFromPoint,
  })

  try {
    await act(async () => {
      fireEvent.pointerDown(overlay as HTMLElement, {
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.pointerUp(overlay as HTMLElement, {
        button: 0,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.click(overlay as HTMLElement, {
        button: 0,
        clientX: x,
        clientY: y,
      })
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  } finally {
    if (previousElementsFromPoint) {
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: previousElementsFromPoint,
      })
    } else {
      Reflect.deleteProperty(document, 'elementsFromPoint')
    }
  }
}

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
          renderTime: 0,
          memoryUsage: 0,
          textureSize: { width: 0, height: 0 },
        }
      }
      dispose() {}
    },
  }
})

beforeEach(() => {
  mockUseCapabilityGate.mockReturnValue({
    ready: true,
    supportStatus: 'supported',
    reason: null,
  })
  mockRawRuntimeAdapter.getPrewarmState.mockReset().mockReturnValue('idle')
  mockRawRuntimeAdapter.prewarm
    .mockReset()
    .mockResolvedValue({ status: 'ready' })

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
    mockUseRawWorkflow.mockReturnValue(rawProcessorViewState())
    mockRawRuntimeAdapter.getPrewarmState.mockReturnValue('pending')

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
    const prevViewport = jotaiStore.get(viewportAtom)
    const reset = vi.fn()
    jotaiStore.set(viewportAtom, {
      ...prevViewport,
      w: 390,
      sm: false,
      md: false,
      lg: false,
      xl: false,
      '2xl': false,
    })
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
      jotaiStore.set(viewportAtom, prevViewport)
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
    render(<RawToolSurface {...rawToolSurfaceProps()} />)

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
    expect(screen.getByRole('tab', { name: 'Standard' })).toBeInTheDocument()
    expect(screen.getByLabelText('Exposure')).toBeInTheDocument()
    expect(screen.queryByText('Log Space')).not.toBeInTheDocument()
  })

  it('keeps LUT loading available before upload without JPEG presets', () => {
    render(<RawToolSurface {...rawToolSurfaceProps({ hasImage: false })} />)

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
    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          disabledReason: 'RAW preview exposure is still being prepared.',
        })}
      />,
    )

    expect(
      screen.getByText('RAW preview exposure is still being prepared.'),
    ).toBeInTheDocument()
  })

  it('keeps compare copy tied to the new split interaction', async () => {
    const user = userEvent.setup()
    render(<RawToolSurface {...rawToolSurfaceProps()} />)

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

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          onCompareReset,
        })}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    const resetButton = screen.getByRole('button', {
      name: 'Reset compare view',
    })
    expect(resetButton).toBeEnabled()

    await user.click(resetButton)

    expect(onCompareReset).toHaveBeenCalledTimes(1)
  })

  it('keeps pending LUT suggestions collapsed until the contract browser opens', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()
    const profile = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Sony Look.cube',
          lutProfileSelection: {
            status: 'recommended',
            fingerprint: 'abc123',
            title: 'Sony Look',
            recommendations: [profile],
          },
          lutProfileResolution: {
            kind: 'recommended',
            recommendations: [profile],
          },
          onLutProfileSelect,
        })}
      />,
    )

    // With a complete recommendation the component surfaces inline rows + recommended note
    expect(
      screen.getByText(
        'Inferred from the file name/metadata — confirm before export.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    // Full suggestion list not rendered inline - only the top recommendation is shown
    expect(
      screen.queryByText('Sony S-Gamut3.Cine / S-Log3 -> Rec.709 display'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    expect(browser).toHaveAttribute('data-raw-lut-browser-dialog', 'contract')
    expect(
      within(browser).getByRole('tablist', { name: 'LUT contract panels' }),
    ).toBeInTheDocument()
    expect(
      within(browser).getAllByText('Sony S-Gamut3.Cine / S-Log3').length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      within(browser).getByLabelText('Search LUT contract'),
    ).toBeInTheDocument()
    expect(
      within(browser).getByRole('button', {
        name: 'Use Sony S-Gamut3.Cine / S-Log3 as LUT input',
      }),
    ).toBeInTheDocument()
  })

  it('closes the LUT contract browser from the outside layer and restores focus', async () => {
    const user = userEvent.setup()
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')!

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Sony Look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'toggle-contract',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile,
            confidence: 'metadata',
          },
        })}
      />,
    )

    const trigger = screen.getByRole('button', {
      name: 'Change LUT contract',
    })

    await user.click(trigger)
    expect(
      screen.getByRole('dialog', { name: 'LUT contract browser' }),
    ).toBeInTheDocument()

    const overlay = document.querySelector('[data-raw-lut-browser-overlay]')
    expect(overlay).toBeInTheDocument()
    await user.click(overlay as HTMLElement)

    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('lets the open LUT contract trigger toggle through the modal layer', async () => {
    const user = userEvent.setup()
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')!

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Sony Look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'toggle-contract',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile,
            confidence: 'metadata',
          },
        })}
      />,
    )

    const trigger = screen.getByRole('button', {
      name: 'Change LUT contract',
    })
    const getRect = mockTriggerRect(trigger, {
      left: 40,
      right: 196,
      top: 80,
      bottom: 112,
    })

    await user.click(trigger)
    expect(
      screen.getByRole('dialog', { name: 'LUT contract browser' }),
    ).toBeInTheDocument()

    await clickOverlayAt(80, 96, [trigger])

    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()

    getRect.mockRestore()
  })

  it('shows resolved LUT input and output contracts', () => {
    const profile = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Panasonic Look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'abc123',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile,
            confidence: 'metadata',
          },
        })}
      />,
    )

    expect(screen.getByText('LUT input:')).toBeInTheDocument()
    expect(screen.getByText('Panasonic V-Gamut / V-Log')).toBeInTheDocument()
    expect(screen.getByText('LUT output:')).toBeInTheDocument()
    expect(screen.getByText('Rec.709 display')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()
  })

  it('makes missing LUT output contracts explicit', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')!

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Panasonic Look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'abc123',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile,
            confidence: 'metadata',
          },
        })}
      />,
    )

    expect(screen.getByText(/choose the LUT output/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toBeInTheDocument()
  })

  it('resets selector state and search when switching LUT fingerprints', async () => {
    const user = userEvent.setup()
    const sonyProfile = getLUTColorProfile('sony-sgamut3cine-slog3')!
    const canonProfile = getLUTColorProfile('canon-cinema-gamut-clog3')!

    const firstLutProps = rawToolSurfaceProps({
      currentLutName: 'Sony Look.cube',
      lutProfileSelection: {
        status: 'confirmed',
        fingerprint: 'first-lut',
        profileId: sonyProfile.id,
        confidence: 'metadata',
      },
      lutProfileResolution: {
        kind: 'confirmed',
        profile: sonyProfile,
        confidence: 'metadata',
      },
    })
    const { rerender } = render(<RawToolSurface {...firstLutProps} />)

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )
    await user.type(screen.getByLabelText('Search LUT contract'), 'panasonic')

    expect(screen.getByLabelText('Search LUT contract')).toHaveValue(
      'panasonic',
    )
    expect(
      screen.queryByText('ARRI Wide Gamut 4 / LogC4'),
    ).not.toBeInTheDocument()

    rerender(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Canon Look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'second-lut',
            profileId: canonProfile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile: canonProfile,
            confidence: 'metadata',
          },
        })}
      />,
    )

    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    expect(screen.getByLabelText('Search LUT contract')).toHaveValue('')
    expect(screen.getByText('ARRI Wide Gamut 4 / LogC4')).toBeInTheDocument()
  })

  it('uses a dedicated LUT contract browser with separate input and output panels', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Unknown Look.cube',
          lutProfileSelection: {
            status: 'unknown',
            fingerprint: 'def456',
            title: 'Unknown Look',
            sourceName: 'Unknown Look.cube',
          },
          lutProfileResolution: {
            kind: 'unknown',
          },
          onLutProfileSelect,
        })}
      />,
    )

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    expect(browser).toBeInTheDocument()
    expect(
      within(browser).getByRole('tab', { name: 'Input', selected: true }),
    ).toBeInTheDocument()
    expect(
      within(browser).getByRole('tab', { name: 'Output', selected: false }),
    ).toBeInTheDocument()

    await user.type(
      within(browser).getByLabelText('Search LUT contract'),
      'v-log',
    )

    const vLogInputButton = within(browser).getByRole('button', {
      name: 'Use Panasonic V-Gamut / V-Log as LUT input',
    })
    expect(vLogInputButton).toBeInTheDocument()
    expect(
      within(browser).queryByRole('button', {
        name: 'Panasonic V-Gamut / V-Log -> Rec.709 display',
      }),
    ).not.toBeInTheDocument()

    await user.click(vLogInputButton)

    expect(
      within(browser).getByRole('tab', { name: 'Output', selected: true }),
    ).toBeInTheDocument()

    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Panasonic V-Gamut / V-Log as LUT output',
      }),
    )

    expect(onLutProfileSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'panasonic-vgamut-vlog',
        role: 'scene-creative',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        outputGamut: 'v-gamut',
        outputTransfer: 'v-log',
        outputRange: 'full',
      }),
    )
    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
  })

  it('passes the full suggested LUT contract when a LUT input is chosen', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()
    const suggestion = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Unknown Look.cube',
          lutProfileSelection: {
            status: 'recommended',
            fingerprint: 'ghi789',
            title: 'Unknown Look',
            recommendations: [suggestion],
          },
          lutProfileResolution: {
            kind: 'recommended',
            recommendations: [suggestion],
          },
          onLutProfileSelect,
        })}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Sony S-Gamut3.Cine / S-Log3 as LUT input',
      }),
    )
    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Rec.709 display as LUT output',
      }),
    )

    expect(onLutProfileSelect).toHaveBeenCalledWith(suggestion)
  })

  it('warns unsupported output LUTs without showing the input selector', () => {
    const suggestion = getLUTColorProfile('sony-sgamut3cine-slog3')!

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Cineon Output.cube',
          lutProfileSelection: {
            status: 'unsupported-output',
            fingerprint: 'jkl012',
            title: 'Cineon Output',
            recommendations: [suggestion],
          },
          lutProfileResolution: {
            kind: 'unsupported-output',
            recommendations: [suggestion],
          },
        })}
      />,
    )

    expect(
      screen.getByText(/This LUT output is not supported yet/),
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()
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
        params={{
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
          viewMode: 'processed',
          compareSplit: 0.5,
          styleKind: 'none',
          builtinPreset: null,
        }}
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

  it('keeps preview stage focus visually neutral', () => {
    const { container } = render(
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

  it('uses a neutral preview mat instead of a black preview background', () => {
    const { container } = render(
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
        params={{
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
          viewMode: 'processed',
          compareSplit: 0.5,
          styleKind: 'none',
          builtinPreset: null,
        }}
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
    expect(fileInput).toHaveAttribute(
      'accept',
      expect.stringContaining('image/*'),
    )
    expect(fileInput).toHaveAttribute('accept', expect.stringContaining('.dng'))
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
              dualWebglAllowed: true,
              imageRef: {
                current: {
                  data: new Float32Array(4),
                  width: 1,
                  height: 1,
                  channels: 4,
                  bitsPerChannel: 32,
                  layout: 'rgba-float32',
                  colorSpace: 'display-srgb-preview',
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
              dualWebglAllowed: false,
              originalReferenceSnapshot: null,
              imageRef: {
                current: {
                  data: new Float32Array(4),
                  width: 1,
                  height: 1,
                  channels: 4,
                  bitsPerChannel: 32,
                  layout: 'rgba-float32',
                  colorSpace: 'display-srgb-preview',
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
            dualWebglAllowed: false,
            originalReferenceSnapshot: snapshot,
            imageRef: {
              current: {
                data: new Float32Array(4),
                width: 1,
                height: 1,
                channels: 4,
                bitsPerChannel: 32,
                layout: 'rgba-float32',
                colorSpace: 'display-srgb-preview',
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

    it('threads dual-webgl compare DOM into the loaded preview surface', async () => {
      const { container } = render(
        <ComparePreviewStage
          {...compareStageProps({
            hasImage: true,
            dualWebglAllowed: true,
            imageRef: {
              current: {
                data: new Float32Array(4),
                width: 1,
                height: 1,
                channels: 4,
                bitsPerChannel: 32,
                layout: 'rgba-float32',
                colorSpace: 'display-srgb-preview',
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
        container.querySelector('[data-compare-mode="dual-webgl"]'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('.raw-preview-original-webgl-layer'),
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
            dualWebglAllowed: false,
            originalReferenceSnapshot: snapshot,
            imageRef: {
              current: {
                data: new Float32Array(4),
                width: 1,
                height: 1,
                channels: 4,
                bitsPerChannel: 32,
                layout: 'rgba-float32',
                colorSpace: 'display-srgb-preview',
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
              data: new Float32Array(4),
              width: 1,
              height: 1,
              channels: 4,
              bitsPerChannel: 32,
              layout: 'rgba-float32',
              colorSpace: 'display-srgb-preview',
              metadata: { width: 1, height: 1 },
              renderExposure: {
                ev: 0,
                multiplier: 1,
                source: 'identity',
              },
            },
          },
        }),
        dualWebglAllowed: false,
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
                  data: new Float32Array(4),
                  width: 1,
                  height: 1,
                  channels: 4,
                  bitsPerChannel: 32,
                  layout: 'rgba-float32',
                  colorSpace: 'display-srgb-preview',
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
                  data: new Float32Array(4),
                  width: 1,
                  height: 1,
                  channels: 4,
                  bitsPerChannel: 32,
                  layout: 'rgba-float32',
                  colorSpace: 'display-srgb-preview',
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
          params={{
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
            viewMode: 'processed',
            compareSplit: 0.5,
            styleKind: 'none',
            builtinPreset: null,
          }}
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
