import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, vi } from 'vitest'

import { ComparePreviewStage } from '../components/ComparePreviewStage'
import { LutDropzone } from '../components/Dropzone'
import { PreviewCanvas } from '../components/PreviewCanvas'
import { RawToolSurface } from '../components/RawToolSurface'
import type { UseRawProcessorReturn } from '../hooks/useRawProcessor'
import { RawProcessorView } from '../RawProcessorView'

const mockUseRawProcessor = vi.hoisted(() => vi.fn())
const mockUseCapabilityGate = vi.hoisted(() => vi.fn())

vi.mock('../hooks', () => ({
  useRawProcessor: mockUseRawProcessor,
}))

vi.mock('../hooks/useCapabilityGate', () => ({
  useCapabilityGate: mockUseCapabilityGate,
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
    onIntensitySelect: () => {},
    onToneChange: () => {},
    onToneReset: () => {},
    onCompareReset: () => {},
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
  overrides: Partial<UseRawProcessorReturn> = {},
): UseRawProcessorReturn {
  return {
    params: {
      userExposureEv: 0,
      userContrast: 0,
      userHighlights: 0,
      userShadows: 0,
      userWhites: 0,
      userBlacks: 0,
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
    exportImage: vi.fn(),
    recoverInterruptedExport: vi.fn(),
    downloadExportResult: vi.fn(),
    shareExportResult: vi.fn(),
    copyExportResult: vi.fn(),
    reset: vi.fn(),
    dismissError: vi.fn(),
    updateStats: vi.fn(),
    pipelineRef: { current: null },
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

  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
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
  it('passes hook histogram state into RAW tools with Histogram', async () => {
    mockUseRawProcessor.mockReturnValue(rawProcessorViewState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    expect(
      screen.getByRole('region', { name: 'Histogram' }),
    ).toBeInTheDocument()
  })

  it('renders Chinese Raw Lab shell when the persisted locale is Chinese', async () => {
    localStorage.setItem('lumaforge.locale', 'zh-CN')
    mockUseRawProcessor.mockReturnValue(rawProcessorViewState())

    await act(async () => {
      render(<RawProcessorView />)
      await Promise.resolve()
    })

    expect(screen.getByText('RAW Lab')).toBeInTheDocument()
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

describe('rawToolSurface', () => {
  it('presents task-grouped RAW tools with Histogram', () => {
    render(<RawToolSurface {...rawToolSurfaceProps()} />)

    expect(
      screen.getByRole('region', { name: 'LUT contract' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Tone' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Strength' })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'Histogram' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'JPEG presets' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Neutral' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Standard' })).toBeInTheDocument()
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

  it('keeps compare copy tied to the new split interaction', () => {
    render(<RawToolSurface {...rawToolSurfaceProps()} />)

    expect(screen.getByRole('region', { name: 'Compare' })).toBeInTheDocument()
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
            status: 'pending',
            fingerprint: 'abc123',
            title: 'Sony Look',
            suggestions: [profile],
          },
          lutProfileResolution: {
            kind: 'needs-user-selection',
            suggestions: [profile],
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
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Sony S-Gamut3.Cine / S-Log3 -> Rec.709 display'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    expect(browser).toHaveAttribute('data-raw-lut-browser-dialog', 'contract')
    expect(browser).toHaveClass('fixed', 'z-60')
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

  it('closes the LUT contract browser when its trigger is clicked again', async () => {
    const user = userEvent.setup()
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')!

    render(
      <RawToolSurface
        {...rawToolSurfaceProps({
          currentLutName: 'Sony Look.cube',
          lutProfileSelection: {
            status: 'resolved',
            fingerprint: 'toggle-contract',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'resolved',
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

    await user.click(trigger)

    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
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
            status: 'resolved',
            fingerprint: 'abc123',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'resolved',
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
            status: 'resolved',
            fingerprint: 'abc123',
            profileId: profile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'resolved',
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
        status: 'resolved',
        fingerprint: 'first-lut',
        profileId: sonyProfile.id,
        confidence: 'metadata',
      },
      lutProfileResolution: {
        kind: 'resolved',
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
            status: 'resolved',
            fingerprint: 'second-lut',
            profileId: canonProfile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'resolved',
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
            status: 'pending',
            fingerprint: 'def456',
            title: 'Unknown Look',
            sourceName: 'Unknown Look.cube',
            suggestions: [],
          },
          lutProfileResolution: {
            kind: 'needs-user-selection',
            suggestions: [],
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
            status: 'pending',
            fingerprint: 'ghi789',
            title: 'Unknown Look',
            suggestions: [suggestion],
          },
          lutProfileResolution: {
            kind: 'needs-user-selection',
            suggestions: [suggestion],
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
            status: 'pending',
            fingerprint: 'jkl012',
            title: 'Cineon Output',
            suggestions: [suggestion],
          },
          lutProfileResolution: {
            kind: 'needs-user-selection',
            suggestions: [suggestion],
            reason: 'unsupported-output',
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

    render(
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

    const stage = screen.getByLabelText('RAW preview comparison')
    const stageFrame = stage.querySelector(':scope > div') as HTMLElement
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

    await user.click(stageFrame)

    expect(createElement).not.toHaveBeenCalled()
    expect(inputClick).not.toHaveBeenCalled()

    fireEvent.drop(stageFrame, {
      dataTransfer: {
        files: [file],
      },
    })

    expect(onRawDrop).toHaveBeenCalledWith([file])
  })

  it('keeps empty preview stage upload button separate from the compare slider', async () => {
    const user = userEvent.setup()

    render(
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

    const stage = screen.getByLabelText('RAW preview comparison')
    const stageFrame = stage.querySelector(':scope > div') as HTMLElement
    const uploadButton = screen.getByRole('button', {
      name: /drop one raw here/i,
    })
    const compareSlider = screen.getByRole('slider', {
      name: 'Compare unprocessed RAW and final JPEG',
    })

    expect(stageFrame).not.toHaveAttribute('tabindex')
    expect(
      screen.queryByRole('button', { name: 'Load RAW file' }),
    ).not.toBeInTheDocument()
    expect(uploadButton).toHaveClass('absolute', 'left-1/2')
    expect(uploadButton).not.toContainElement(compareSlider)
    expect(stageFrame).toContainElement(uploadButton)
    expect(stageFrame).toContainElement(compareSlider)

    const input = document.createElement('input')
    const inputClick = vi.spyOn(input, 'click').mockImplementation(() => {})
    const createElement = vi
      .spyOn(document, 'createElement')
      .mockReturnValue(input)

    await user.click(uploadButton)

    expect(createElement).toHaveBeenCalledWith('input')
    expect(inputClick).toHaveBeenCalledTimes(1)
  })

  describe('comparePreviewStage', () => {
    it('places upload inside the empty compare stage', () => {
      const { container } = render(
        <ComparePreviewStage {...compareStageProps()} />,
      )

      const stage = screen.getByLabelText('RAW preview comparison')
      const uploadButton = screen.getByRole('button', {
        name: /drop one raw here/i,
      })
      const sample = container.querySelector<HTMLElement>(
        '[style*="--raw-compare-split-committed"]',
      )

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
      expect(arc).toHaveAttribute('stroke', 'oklch(0.78 0.16 63)')
      expect(screen.getByText('50%')).toHaveClass('text-[oklch(0.97_0.014_86)]')
    })

    it('keeps compare labels when an image is loaded', async () => {
      await act(async () => {
        render(
          <ComparePreviewStage
            {...compareStageProps({
              hasImage: true,
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
        screen.queryByRole('button', { name: /drop one raw here/i }),
      ).not.toBeInTheDocument()
      expect(screen.queryByText('Drop one RAW here')).not.toBeInTheDocument()
      expect(screen.getByText('Unprocessed RAW')).toBeInTheDocument()
      expect(screen.getByText('Final JPEG')).toBeInTheDocument()
      expect(
        screen.getByRole('slider', {
          name: 'Compare unprocessed RAW and final JPEG',
        }),
      ).toBeInTheDocument()
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
