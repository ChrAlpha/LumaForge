import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Provider } from 'jotai'
import { describe, expect, it, vi } from 'vitest'

import { viewportAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../state/tool-card.atoms'
import { LutDropzone } from './Dropzone'
import { RawToolSurface } from './RawToolSurface'

const baseProps = {
  activeIntensity: 'standard' as const,
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
  onIntensitySelect: vi.fn(),
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onColorChange: vi.fn(),
  onColorReset: vi.fn(),
  onSelectiveColorChange: vi.fn(),
  onSelectiveColorReset: vi.fn(),
  onCompareReset: vi.fn(),
  viewMode: 'processed' as const,
  onViewModeChange: vi.fn(),
  compareSplit: 0.5,
  onCompareSplitChange: vi.fn(),
  fileName: 'DSC09142.ARW',
  onReplaceFile: vi.fn(),
  onResetSession: vi.fn(),
  onLutLoad: vi.fn(),
  onLutClear: vi.fn(),
  onLutProfileSelect: vi.fn(),
  onExport: vi.fn(),
  canExport: false,
  disabledReason: 'Full-resolution export source is still loading.',
  isProcessing: false,
  exportResult: null,
  exportShareCapability: {
    available: false as const,
    reason: 'Export a JPEG before sharing.',
  },
  histogram: { state: 'unavailable' as const, reason: 'no-image' as const },
  onShareExport: vi.fn(),
  onDownloadExport: vi.fn(),
  onCopyExport: vi.fn(),
  hasImage: false,
  currentLutName: null,
  lutProfileSelection: null,
  lutProfileResolution: null,
  supportLevel: 'experimental' as const,
  metadata: null,
  stats: null,
}

function onlineLutSourcesFixture(
  overrides: Partial<UseOnlineLutSourcesResult> = {},
): UseOnlineLutSourcesResult {
  return {
    state: {
      resources: [
        {
          id: 'source-1',
          url: 'https://profiles.example.com/releases/v2026.05.01/catalog.json',
          type: 'catalog',
          label: 'Catalog from profiles.example.com',
          fromQuery: true,
        },
      ],
      entries: [
        {
          id: 'kodak-2383-rec709',
          resourceId: 'source-1',
          title: 'Kodak 2383 Rec.709',
          sourceUrl:
            'https://profiles.example.com/releases/v2026.05.01/entries/kodak-2383-rec709.json',
          sourceType: 'catalog-entry',
          cube: {
            url: 'https://profiles.example.com/blobs/kodak-2383-rec709.cube',
            sha256:
              '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab',
            bytes: 12,
            title: 'Kodak 2383 Rec.709',
          },
          preview: {
            url: 'https://profiles.example.com/previews/kodak-2383-rec709.webp',
            mediaType: 'image/webp',
            bytes: 4096,
            width: 320,
            height: 180,
            title: 'Kodak 2383 Rec.709',
          },
          tags: [],
          trustedContract: {
            role: 'combined-look-output',
            inputGamut: 'arri-wide-gamut-3',
            inputTransfer: 'logc3',
            outputGamut: 'srgb-rec709',
            outputTransfer: 'gamma24',
            outputRange: 'legal',
          },
        },
      ],
      issues: [],
      activeResourceId: 'source-1',
      isLoading: false,
    },
    sourceUrlInput: '',
    setSourceUrlInput: vi.fn(),
    addSourceFromInput: vi.fn(),
    refreshSource: vi.fn(),
    removeSource: vi.fn(),
    loadEntry: vi.fn(async (): Promise<'loaded'> => 'loaded'),
    loadingEntryId: null,
    failedEntryId: null,
    entryLoadProgress: null,
    cancelEntryLoad: vi.fn(),
    share: {
      enabled: true,
      url: '/raw?luts=https%3A%2F%2Fprofiles.example.com%2Freleases%2Fv2026.05.01%2Fcatalog.json',
      copy: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  }
}

function withManyOnlineEntries(fixture: UseOnlineLutSourcesResult) {
  const [firstEntry] = fixture.state.entries
  fixture.state = {
    ...fixture.state,
    entries: [
      firstEntry,
      {
        ...firstEntry,
        id: 'ektachrome-e100',
        title: 'Ektachrome E100',
        sourceUrl:
          'https://profiles.example.com/releases/v2026.05.01/entries/ektachrome-e100.json',
        cube: {
          ...firstEntry.cube,
          title: 'Ektachrome E100',
          url: 'https://profiles.example.com/blobs/ektachrome-e100.cube',
        },
      },
      {
        ...firstEntry,
        id: 'portra-400',
        title: 'Portra 400',
        sourceUrl:
          'https://profiles.example.com/releases/v2026.05.01/entries/portra-400.json',
        cube: {
          ...firstEntry.cube,
          title: 'Portra 400',
          url: 'https://profiles.example.com/blobs/portra-400.cube',
        },
      },
      {
        ...firstEntry,
        id: 'vision3-250d',
        title: 'Vision3 250D',
        sourceUrl:
          'https://profiles.example.com/releases/v2026.05.01/entries/vision3-250d.json',
        cube: {
          ...firstEntry.cube,
          title: 'Vision3 250D',
          url: 'https://profiles.example.com/blobs/vision3-250d.cube',
        },
      },
      {
        ...firstEntry,
        id: 'velvia-50',
        title: 'Velvia 50',
        sourceUrl:
          'https://profiles.example.com/releases/v2026.05.01/entries/velvia-50.json',
        cube: {
          ...firstEntry.cube,
          title: 'Velvia 50',
          url: 'https://profiles.example.com/blobs/velvia-50.cube',
        },
      },
    ],
  }

  return fixture
}

function getToneRegion() {
  return screen.getByRole('region', { name: 'Adjust' })
}

function resetToolCards() {
  act(() => {
    jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS)
  })
}

describe('rawToolSurface', () => {
  beforeEach(() => {
    localStorage.clear()
    resetToolCards()
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetToolCards()
    localStorage.clear()
  })

  it('renders the finishing surface with a card stack and a persistent export block', () => {
    const { container } = render(<RawToolSurface {...baseProps} />)
    const desktopSurface = container.querySelector(
      '[data-raw-tool-surface="raw-finishing"]',
    )
    expect(desktopSurface).toBeInTheDocument()
    expect(desktopSurface).toHaveAttribute(
      'data-raw-desktop-chrome',
      'on-photo-tools',
    )
    expect(desktopSurface).toHaveAttribute(
      'data-raw-desktop-density',
      'linear-compact',
    )
    expect(desktopSurface).toHaveAttribute(
      'data-raw-desktop-input',
      'mouse-keyboard',
    )
    expect(desktopSurface).toHaveClass('bg-lf-on-photo-bg-strong')
    // card stack present
    expect(
      screen.getByRole('group', { name: 'RAW finishing controls' }),
    ).toBeInTheDocument()
    // Look (LUT contract + strength) open by default → region present
    expect(
      screen.getAllByRole('region', { name: 'LUT contract' }).length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      screen.getAllByRole('region', { name: 'Adjust' }).length,
    ).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('[data-tool-card="adjust"]')).toBeTruthy()
    expect(container.querySelector('[data-tool-card="tone"]')).toBeNull()
    expect(
      Array.from(container.querySelectorAll('[data-tool-card]'), (card) =>
        card.getAttribute('data-tool-card'),
      ),
    ).toEqual(['histogram', 'look', 'adjust', 'compare', 'fileFacts'])
    // Export is a persistent, non-collapsible region
    const exportRegion = screen.getByRole('region', { name: 'Export' })
    expect(exportRegion).toHaveAttribute('data-raw-export-block', 'persistent')
    // collapsed-by-default reference cards are not expanded
    expect(screen.queryByRole('region', { name: 'Histogram' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Compare' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'File facts' })).toBeNull()
    // but their triggers exist
    expect(
      screen.getByRole('button', { name: 'Histogram' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'File facts' }),
    ).toBeInTheDocument()

    // Desktop branch renders the aside surface; the photo-first mobile
    // chrome is JS-gated and not mounted at the jsdom default width.
    expect(
      container.querySelector('[data-raw-mobile-lab]'),
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-raw-tool-surface="raw-finishing"]'),
    ).toBeInTheDocument()
  })

  it('keeps the catalog URL input focus ring clear of the LUT card header', () => {
    const { container } = render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    expect(
      container.querySelector('[data-raw-lut="source-controls"]'),
    ).toHaveClass('pt-1')
  })

  it('surfaces first profile LUT entries inline before opening the full catalog', async () => {
    const user = userEvent.setup()
    const fixture = withManyOnlineEntries(onlineLutSourcesFixture())
    render(<RawToolSurface {...baseProps} onlineLutSources={fixture} />)

    await user.click(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    )

    await waitFor(() =>
      expect(fixture.loadEntry).toHaveBeenCalledWith('kodak-2383-rec709'),
    )
    expect(
      screen.getByRole('button', {
        name: /open catalog from profiles.example.com/i,
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Velvia 50')).not.toBeInTheDocument()
  })

  it('matches the empty LUT copy scale to the catalog source hint', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      ...fixture.state,
      resources: [],
      entries: [],
      issues: [],
      activeResourceId: null,
    }

    render(<RawToolSurface {...baseProps} onlineLutSources={fixture} />)

    const catalogHint = screen.getByText(
      'Paste a catalog.json or lumaforge-profiles.json URL to load shared LUTs.',
    )
    const lutHint = screen.getByText(
      'Add a .cube LUT now, it stays staged until a RAW file is loaded.',
    )

    expect(lutHint).toHaveClass(
      'm-0',
      'text-[0.72rem]',
      'leading-relaxed',
      'text-lf-on-surface/72',
    )
    expect(lutHint.className).toBe(catalogHint.className)
  })

  it('reveals the histogram plot when its card is expanded', async () => {
    const user = userEvent.setup()
    const luma = new Uint32Array(256)
    const red = new Uint32Array(256)
    luma[0] = 1
    luma[255] = 1
    red[0] = 1
    red[255] = 1

    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        histogram={{
          state: 'ready',
          source: 'quick',
          width: 2,
          height: 1,
          sampledPixels: 2,
          totalPixels: 2,
          bins: {
            luma,
            red,
            green: new Uint32Array(256),
            blue: new Uint32Array(256),
          },
          clipping: {
            shadowAnyChannel: 1,
            highlightAnyChannel: 1,
            shadowLuma: 1,
            highlightLuma: 1,
          },
          diagnostics: {
            ownership: 'main-thread-chunked-no-copy',
            copiedInputBytes: 0,
            transferredInput: false,
            inputByteLength: 12,
            rowBandRows: 32,
          },
        }}
      />,
    )

    // The trigger meta speaks in shares of the frame, like the card body.
    expect(screen.getByText('Shadows 50% · Highlights 50%')).toHaveClass(
      'tabular-nums',
    )
    await user.click(screen.getByRole('button', { name: 'Histogram' }))
    const regions = await screen.findAllByRole('region', { name: 'Histogram' })
    expect(regions.length).toBeGreaterThanOrEqual(1)
    expect(
      within(regions[0]).getByLabelText('Preview luminance and RGB histogram'),
    ).toBeInTheDocument()
  })

  it('shows unsupported histogram state without stale bins', async () => {
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        histogram={{
          state: 'unsupported',
          reason:
            'Built-in styles are not supported by full-resolution JPEG export.',
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Histogram' }))
    const regions = await screen.findAllByRole('region', { name: 'Histogram' })
    expect(regions.length).toBeGreaterThanOrEqual(1)
    const histogram = regions[0]

    expect(within(histogram).getByText('Unsupported')).toBeInTheDocument()
    expect(
      within(histogram).queryByLabelText('Preview luminance and RGB histogram'),
    ).not.toBeInTheDocument()
  })

  it('sends normalized tone changes and calls tone reset', async () => {
    const user = userEvent.setup()
    const onToneChange = vi.fn()
    const onToneReset = vi.fn()
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        tone={{
          userExposureEv: 0,
          userContrast: 12,
          userHighlights: 0,
          userShadows: 0,
          userWhites: 0,
          userBlacks: 0,
        }}
        onToneChange={onToneChange}
        onToneReset={onToneReset}
      />,
    )

    const tone = getToneRegion()

    expect(within(tone).getByText('Exposure')).toBeInTheDocument()
    expect(within(tone).getByText('Contrast')).toBeInTheDocument()
    expect(within(tone).getByText('Highlights')).toBeInTheDocument()
    expect(within(tone).getByText('Shadows')).toBeInTheDocument()
    expect(within(tone).getByText('Whites')).toBeInTheDocument()
    expect(within(tone).getByText('Blacks')).toBeInTheDocument()

    const exposure = within(tone).getByRole('slider', { name: 'Exposure' })
    const exposureLabelledBy = exposure.getAttribute('aria-labelledby')
    expect(exposureLabelledBy).toBeTruthy()
    expect(
      exposure.ownerDocument.getElementById(exposureLabelledBy!),
    ).toHaveTextContent('Exposure')
    exposure.focus()
    await user.keyboard('{ArrowRight}')
    expect(onToneChange).toHaveBeenLastCalledWith({ userExposureEv: 0.01 })

    const highlights = within(tone).getByRole('slider', { name: 'Highlights' })
    highlights.focus()
    await user.keyboard('{ArrowLeft}')
    expect(onToneChange).toHaveBeenLastCalledWith({ userHighlights: -1 })

    await user.click(screen.getByRole('button', { name: 'Reset tone' }))
    expect(onToneReset).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Reset tone' }),
    ).toBeInTheDocument()
  })

  it('stacks desktop Adjust tone and color controls with scoped resets', async () => {
    const user = userEvent.setup()
    const onToneReset = vi.fn()
    const onColorReset = vi.fn()

    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        tone={{ ...baseProps.tone, userContrast: 12 }}
        color={{
          userTemperature: 18,
          userTint: 0,
          userSaturation: 0,
          userVibrance: 0,
        }}
        onColorChange={vi.fn()}
        onColorReset={onColorReset}
        onToneReset={onToneReset}
      />,
    )

    const adjust = screen.getByRole('region', { name: 'Adjust' })
    expect(
      within(adjust).queryByRole('tablist', { name: 'Adjust' }),
    ).not.toBeInTheDocument()
    expect(within(adjust).getByText('Exposure')).toBeInTheDocument()
    expect(within(adjust).getByText('Contrast')).toBeInTheDocument()
    expect(within(adjust).getByText('Temperature')).toBeInTheDocument()
    expect(within(adjust).getByText('Tint')).toBeInTheDocument()

    await user.click(within(adjust).getByRole('button', { name: 'Reset tone' }))
    expect(onToneReset).toHaveBeenCalledTimes(1)
    expect(onColorReset).not.toHaveBeenCalled()

    await user.click(
      within(adjust).getByRole('button', { name: 'Reset color' }),
    )

    expect(onColorReset).toHaveBeenCalledTimes(1)
    expect(onToneReset).toHaveBeenCalledTimes(1)
  })

  it('disables reset color when color controls are neutral', () => {
    render(<RawToolSurface {...baseProps} hasImage />)

    const adjust = screen.getByRole('region', { name: 'Adjust' })

    expect(
      within(adjust).getByRole('button', { name: 'Reset color' }),
    ).toBeDisabled()
  })

  it('disables reset tone when tone controls are neutral', () => {
    render(<RawToolSurface {...baseProps} hasImage />)

    const adjust = screen.getByRole('region', { name: 'Adjust' })

    expect(
      within(adjust).getByRole('button', { name: 'Reset tone' }),
    ).toBeDisabled()
  })

  it('disables tone controls before upload', async () => {
    render(<RawToolSurface {...baseProps} />)

    const tone = getToneRegion()
    expect(
      within(tone).getByRole('slider', { name: 'Exposure' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Contrast' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Highlights' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Shadows' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Whites' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Blacks' }),
    ).toHaveAttribute('data-disabled')
    expect(
      within(tone).getByRole('slider', { name: 'Temperature' }),
    ).toHaveAttribute('data-disabled')
    expect(within(tone).getByRole('slider', { name: 'Tint' })).toHaveAttribute(
      'data-disabled',
    )
    expect(screen.getByRole('button', { name: 'Reset tone' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset color' })).toBeDisabled()
  })

  it('disables preview-dependent editing while the preview is released after export', () => {
    render(<RawToolSurface {...baseProps} hasImage previewSuspended />)

    const tone = getToneRegion()
    expect(
      within(tone).getByRole('slider', { name: 'Exposure' }),
    ).toHaveAttribute('data-disabled')
    expect(screen.getByRole('button', { name: 'Reset tone' })).toBeDisabled()
    expect(screen.getByLabelText(/add \.cube lut/i)).toBeDisabled()
  })

  it('uses Raw Lab-specific reset controls for tone and compare', async () => {
    const user = userEvent.setup()
    const onCompareReset = vi.fn()
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        onCompareReset={onCompareReset}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Reset tone' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compare' }))
    await user.click(screen.getByRole('button', { name: 'Reset compare view' }))

    expect(onCompareReset).toHaveBeenCalledTimes(1)
  })

  it('selects a strength level', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
        onIntensitySelect={onChange}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Off' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Light' })).toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: 'Strength' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Standard' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: 'Strong' })).toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: 'Strong' }))

    expect(onChange).toHaveBeenCalledWith('strong')
  })

  it('selects the next strength level with keyboard arrows', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
        onIntensitySelect={onChange}
      />,
    )

    const strength = screen.getByRole('tablist', { name: 'Strength' })
    const standard = within(strength).getByRole('tab', { name: 'Standard' })

    expect(standard).toHaveAttribute('tabIndex', '0')

    standard.focus()
    await user.keyboard('{ArrowRight}')

    expect(onChange).toHaveBeenCalledWith('strong')
    expect(within(strength).getByRole('tab', { name: 'Strong' })).toHaveFocus()
  })

  it('updates selected strength from props without remounting the tablist', () => {
    const { rerender } = render(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
      />,
    )

    const strength = screen.getByRole('tablist', { name: 'Strength' })
    expect(
      within(strength).getByRole('tab', { name: 'Standard' }),
    ).toHaveAttribute('aria-selected', 'true')

    rerender(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
        activeIntensity="strong"
      />,
    )

    const updatedStrength = screen.getByRole('tablist', { name: 'Strength' })
    expect(updatedStrength).toBe(strength)
    expect(
      within(updatedStrength).getByRole('tab', { name: 'Strong' }),
    ).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps controlled strength selection when the parent rejects a change', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
        onIntensitySelect={onChange}
      />,
    )

    const strength = screen.getByRole('tablist', { name: 'Strength' })

    await user.click(within(strength).getByRole('tab', { name: 'Strong' }))

    expect(onChange).toHaveBeenCalledWith('strong')

    rerender(
      <RawToolSurface
        {...baseProps}
        hasImage
        currentLutName="Sony Look.cube"
        activeIntensity="standard"
        onIntensitySelect={onChange}
      />,
    )

    expect(
      within(strength).getByRole('tab', { name: 'Standard' }),
    ).toHaveAttribute('aria-selected', 'true')
    expect(
      within(strength).getByRole('tab', { name: 'Strong' }),
    ).toHaveAttribute('aria-selected', 'false')
  })

  it('keeps strength disabled for catalog-only online LUT sources', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        onlineLutSources={onlineLutSourcesFixture()}
        onIntensitySelect={onChange}
      />,
    )

    const strength = screen.getByRole('tablist', { name: 'Strength' })
    const strong = within(strength).getByRole('tab', { name: 'Strong' })

    expect(strong).toBeDisabled()
    expect(strong).toHaveAttribute('aria-disabled', 'true')

    await user.click(strong)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables strength tabs before upload', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<RawToolSurface {...baseProps} onIntensitySelect={onChange} />)

    const strength = screen.getByRole('tablist', { name: 'Strength' })
    const strong = within(strength).getByRole('tab', { name: 'Strong' })

    expect(strong).toBeDisabled()
    expect(strong).toHaveAttribute('aria-disabled', 'true')

    await user.click(strong)

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not select disabled strength tabs from keyboard input', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<RawToolSurface {...baseProps} onIntensitySelect={onChange} />)

    const strength = screen.getByRole('tablist', { name: 'Strength' })
    const standard = within(strength).getByRole('tab', { name: 'Standard' })

    standard.focus()
    await user.keyboard('{ArrowRight}')

    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows preserved tone state for non-neutral tone', () => {
    render(
      <RawToolSurface
        {...baseProps}
        hasImage
        tone={{
          userExposureEv: 0,
          userContrast: 0,
          userHighlights: -40,
          userShadows: 40,
          userWhites: -20,
          userBlacks: 20,
        }}
      />,
    )

    expect(screen.getByText('Tone settings preserved')).toBeInTheDocument()
  })

  it('keeps long LUT names inside the tool column while preserving the full name', () => {
    const currentLut =
      'Fujifilm-GFX100RF-F-Log2C-to-Classic-Negative-Rec709-Display-Extremely-Long-Client-Delivery-Name.cube'

    render(<LutDropzone currentLut={currentLut} onFileDrop={vi.fn()} />)

    const label = screen.getByLabelText(/add \.cube lut/i)
    const frame = label.closest('label')
    const fileName = screen.getByText(currentLut)

    expect(frame).toHaveAttribute('data-raw-lut', 'dropzone')
    expect(fileName).toHaveAttribute('title', currentLut)
  })

  it('renders online LUT sources as collapsed summary rows by default', async () => {
    const user = userEvent.setup()
    const fixture = withManyOnlineEntries(onlineLutSourcesFixture())
    const { container } = render(
      <RawToolSurface {...baseProps} onlineLutSources={fixture} />,
    )

    expect(
      screen.getByText('Catalog from profiles.example.com'),
    ).toBeInTheDocument()
    expect(screen.getByText('5 LUTs')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Open Catalog from profiles.example.com',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Refresh Catalog from profiles.example.com',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Remove Catalog from profiles.example.com',
      }),
    ).toBeInTheDocument()

    const inlineEntries = container.querySelector(
      '[data-raw-lut="source-inline-entries"]',
    )
    expect(inlineEntries).toBeInTheDocument()
    expect(
      within(inlineEntries as HTMLElement).getByRole('button', {
        name: 'Load Kodak 2383 Rec.709',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Velvia 50')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(
      within(inlineEntries as HTMLElement).getByRole('button', {
        name: 'Load Kodak 2383 Rec.709',
      }),
    )
    await waitFor(() =>
      expect(fixture.loadEntry).toHaveBeenCalledWith('kodak-2383-rec709'),
    )
  })

  it('closes the online LUT browser with Escape or outside click and restores focus', async () => {
    const user = userEvent.setup()
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    const open = screen.getByRole('button', {
      name: 'Open Catalog from profiles.example.com',
    })

    await user.click(open)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(open).toHaveFocus()

    await user.click(open)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    const overlay = document.querySelector('[data-raw-lut-browser-overlay]')
    expect(overlay).toBeInTheDocument()
    await user.click(overlay as HTMLElement)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(open).toHaveFocus()
  })

  it('acks an online LUT entry load click before the load resolves', async () => {
    const user = userEvent.setup()
    const rafQueue: FrameRequestCallback[] = []
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        rafQueue.push(callback)
        return rafQueue.length
      }),
    )
    const loadHandle: { resolve: (() => void) | null } = { resolve: null }
    const loadEntry = vi.fn(
      () =>
        new Promise<'loaded'>((resolve) => {
          loadHandle.resolve = () => resolve('loaded')
        }),
    )

    try {
      render(
        <RawToolSurface
          {...baseProps}
          onlineLutSources={onlineLutSourcesFixture({ loadEntry })}
        />,
      )

      await user.click(
        screen.getByRole('button', {
          name: 'Open Catalog from profiles.example.com',
        }),
      )

      const sourceBrowserList = document.querySelector(
        '[data-raw-lut="source-browser-list"]',
      ) as HTMLElement
      expect(sourceBrowserList).toBeInTheDocument()
      const loadButton = within(sourceBrowserList).getByRole('button', {
        name: /load kodak 2383 rec.709/i,
      })
      expect(loadButton).not.toHaveAttribute('aria-busy', 'true')

      await user.click(loadButton)

      // While loading the action flips to a cancel affordance.
      await within(sourceBrowserList).findByRole('button', {
        name: /cancel download of kodak 2383 rec.709/i,
        busy: true,
      })
      expect(loadEntry).not.toHaveBeenCalled()

      await act(async () => {
        const queued = rafQueue.splice(0)
        for (const callback of queued) callback(performance.now())
        await Promise.resolve()
      })
      expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709')

      await act(async () => {
        loadHandle.resolve?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(
        screen.queryByRole('dialog', {
          name: 'Catalog from profiles.example.com LUTs',
        }),
      ).not.toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not add search, filtering, sorting, favorites, or catalog-management controls to source UI', async () => {
    const user = userEvent.setup()
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    await user.click(
      screen.getByRole('button', {
        name: 'Open Catalog from profiles.example.com',
      }),
    )

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /search|filter|sort|favorite|manage|catalog management/i,
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByPlaceholderText(/search|filter/i),
    ).not.toBeInTheDocument()
  })

  it('keeps manual upload visible beside online source controls', () => {
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    expect(screen.getByLabelText(/add \.cube lut/i)).toBeInTheDocument()
  })

  it('reflects online LUT share availability on the share button', () => {
    const { rerender } = render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture({
          share: {
            enabled: false,
            url: '/raw',
            copy: vi.fn().mockResolvedValue(undefined),
          },
        })}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Copy LUT source link' }),
    ).toBeDisabled()

    rerender(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Copy LUT source link' }),
    ).toBeEnabled()
  })

  it('uses Raw Lab-specific materials for LUT contract controls', () => {
    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="Unknown Look.cube"
        lutProfileSelection={{
          status: 'unknown',
          fingerprint: 'lut-contract-materials',
          title: 'Unknown Look',
        }}
        lutProfileResolution={{
          kind: 'unknown',
        }}
      />,
    )

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toHaveAttribute('data-raw-lut', 'contract-status')
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toHaveAttribute('data-raw-lut', 'contract-change-button')
  })

  it('marks the resolved LUT output contract as active in the contract browser', async () => {
    const user = userEvent.setup()
    const sonyProfile = getLUTColorProfile('sony-sgamut3cine-slog3')!
    const resolvedProfile = {
      ...sonyProfile,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="SLog3SGamut3.CineToLC_709.cube"
        lutProfileSelection={{
          status: 'confirmed',
          fingerprint: 'stable-catalog-lut',
          profileId: resolvedProfile.id,
          confidence: 'metadata',
        }}
        lutProfileResolution={{
          kind: 'confirmed',
          profile: resolvedProfile,
          confidence: 'metadata',
        }}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )
    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })

    await user.click(within(browser).getByRole('tab', { name: 'Output' }))

    expect(
      within(browser).getByRole('button', {
        name: 'Use Rec.709 display as LUT output',
      }),
    ).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows each declared output contract once in the contract browser', async () => {
    const user = userEvent.setup()
    const sonyProfile = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }
    const panasonicProfile = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="stable-catalog-look.cube"
        lutProfileSelection={{
          status: 'recommended',
          fingerprint: 'stable-catalog-look',
          title: 'Stable catalog look',
          recommendations: [sonyProfile, panasonicProfile],
        }}
        lutProfileResolution={{
          kind: 'recommended',
          recommendations: [sonyProfile, panasonicProfile],
        }}
      />,
    )

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )
    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })

    await user.click(within(browser).getByRole('tab', { name: 'Output' }))

    expect(
      within(browser).getAllByRole('button', {
        name: 'Use Rec.709 display as LUT output',
      }),
    ).toHaveLength(1)
  })

  it('shows a busy refresh affordance while an online LUT source is loading', () => {
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture({
          state: {
            ...onlineLutSourcesFixture().state,
            entries: [],
            activeResourceId: 'source-1',
            isLoading: true,
          },
        })}
      />,
    )

    const refresh = screen.getByRole('button', {
      name: 'Refresh Catalog from profiles.example.com',
    })

    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(refresh).toHaveAttribute('data-raw-lut-busy', 'true')
    expect(screen.getByText('Loading')).toBeInTheDocument()
  })

  it('announces a translated online LUT source issue summary as a status update', () => {
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture({
          state: {
            ...onlineLutSourcesFixture().state,
            issues: [
              {
                code: 'network',
                message:
                  'Failed to fetch online profile resource: https://profiles.example.com/catalog.json',
                resourceId: 'source-1',
              },
            ],
          },
        })}
      />,
    )

    const resource = screen
      .getByRole('button', {
        name: /open catalog/i,
      })
      .closest('[data-raw-lut="source-resource"]') as HTMLElement
    expect(resource).not.toBeNull()
    const status = within(resource).getByRole('status')

    expect(status).toHaveAttribute('aria-live', 'polite')
    // Raw runtime strings (with URLs) are collapsed into translated copy.
    expect(status).toHaveTextContent('This source could not be reached.')
    expect(status).not.toHaveTextContent('https://')
    expect(within(resource).getByText('Issue')).toBeInTheDocument()
  })

  it('mobile + no image keeps onboarding upload between branded topbar and toolbar', () => {
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      const { container } = render(
        <Provider store={jotaiStore}>
          <RawToolSurface {...baseProps} hasImage={false} />
        </Provider>,
      )
      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        screen.getByRole('heading', { name: /lumaforge raw lab/i }),
      ).toBeInTheDocument()
      expect(
        container.querySelector('[data-mobile-empty-state]'),
      ).toBeInTheDocument()
      expect(
        container.querySelector('[data-mobile-empty-prestage]'),
      ).not.toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /browse raw files/i }),
      ).toBeInTheDocument()
      expect(
        container.querySelector('[data-mobile-topbar]'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('tablist', { name: /lab modes/i }),
      ).toBeInTheDocument()
      expect(
        container.querySelector('[data-testid="mobile-peek-surface"]'),
      ).toBeNull()
      expect(
        screen.queryByRole('tablist', { name: /tone parameters/i }),
      ).toBeNull()
      // desktop aside not mounted on mobile
      expect(
        container.querySelector('[data-raw-tool-surface="raw-finishing"]'),
      ).toBeNull()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('mobile + image mounts the photo-first chrome', () => {
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      const { container } = render(
        <Provider store={jotaiStore}>
          <RawToolSurface {...baseProps} hasImage />
        </Provider>,
      )
      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        screen.getByRole('tablist', { name: /lab modes/i }).parentElement,
      ).toHaveClass('pointer-events-auto')
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('mobile keeps strength disabled for catalog-only online LUT sources', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      render(
        <Provider store={jotaiStore}>
          <RawToolSurface
            {...baseProps}
            hasImage
            onlineLutSources={onlineLutSourcesFixture()}
            onIntensitySelect={onChange}
          />
        </Provider>,
      )

      const dock = screen.getByRole('tablist', { name: /lab modes/i })
      expect(within(dock).getAllByRole('tab')).toHaveLength(2)
      expect(
        within(dock).queryByRole('tab', { name: /strength/i }),
      ).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: /lut browser/i }))

      const lutBrowser = screen.getByRole('dialog', { name: /lut browser/i })
      const strength = within(lutBrowser).getByRole('tablist', {
        name: 'Strength',
      })
      const strong = within(strength).getByRole('tab', { name: 'Strong' })

      expect(strong).toBeDisabled()
      expect(strong).toHaveAttribute('aria-disabled', 'true')

      await user.click(strong)

      expect(onChange).not.toHaveBeenCalled()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('mobile lets the stage handoff receive touch while processing', () => {
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      const { container } = render(
        <Provider store={jotaiStore}>
          <RawToolSurface {...baseProps} hasImage isProcessing />
        </Provider>,
      )

      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        container.querySelector('[data-mobile-topbar]'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('tablist', { name: /lab modes/i }),
      ).toBeInTheDocument()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('mobile keeps export result actions reachable through the toolbar while the preview is released', () => {
    const prev = jotaiStore.get(viewportAtom)
    jotaiStore.set(viewportAtom, { ...prev, w: 390, sm: false })
    try {
      const { container } = render(
        <Provider store={jotaiStore}>
          <RawToolSurface
            {...baseProps}
            hasImage
            previewSuspended
            exportResult={{
              output: {
                kind: 'blob',
                filename: 'DSC09142_fullres.jpg',
                blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
                byteLength: 4,
                mimeType: 'image/jpeg',
              },
              filename: 'DSC09142_fullres.jpg',
              width: 6000,
              height: 4000,
              size: 4,
              createdAt: 0,
              copyCapability: {
                mode: 'preview-size',
                label: 'Copy preview-size image',
                reason: 'Full-resolution copy is not available.',
              },
            }}
            exportShareCapability={{ available: true }}
          />
        </Provider>,
      )

      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        container.querySelector('[data-mobile-released-export-actions]'),
      ).not.toBeInTheDocument()
      expect(
        container.querySelector('[data-mobile-topbar]'),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('tablist', { name: /lab modes/i }),
      ).toBeInTheDocument()
      expect(
        screen.getByRole('button', { name: /download/i }),
      ).toBeInTheDocument()
    } finally {
      jotaiStore.set(viewportAtom, prev)
    }
  })

  it('renders input and output rows with apply-contract button for a complete recommendation', async () => {
    const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')!
    const completeProfile = {
      ...vlog709,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="VLog-to-Rec709.cube"
        lutProfileSelection={{
          status: 'recommended',
          fingerprint: 'vlog-rec709',
          title: 'VLog to Rec.709',
          recommendations: [completeProfile],
        }}
        lutProfileResolution={{
          kind: 'recommended',
          recommendations: [completeProfile],
        }}
      />,
    )

    const contractRegions = screen.getAllByRole('region', {
      name: 'LUT contract',
    })
    const contractRegion = contractRegions[0]
    expect(within(contractRegion).getByText('LUT input:')).toBeInTheDocument()
    expect(within(contractRegion).getByText('LUT output:')).toBeInTheDocument()
    expect(
      within(contractRegion).getByRole('button', {
        name: 'Use this contract',
      }),
    ).toHaveAttribute('data-raw-lut', 'apply-contract')
  })

  it('clicking apply-contract calls onLutProfileSelect with the recommendation profile', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()
    const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')!
    const completeProfile = {
      ...vlog709,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="VLog-to-Rec709.cube"
        onLutProfileSelect={onLutProfileSelect}
        lutProfileSelection={{
          status: 'recommended',
          fingerprint: 'vlog-rec709',
          title: 'VLog to Rec.709',
          recommendations: [completeProfile],
        }}
        lutProfileResolution={{
          kind: 'recommended',
          recommendations: [completeProfile],
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Use this contract' }))

    expect(onLutProfileSelect).toHaveBeenCalledWith(completeProfile)
  })

  it('renders choose-output button for input-only recommendation and opens browser on click', async () => {
    const user = userEvent.setup()
    const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')!

    render(
      <RawToolSurface
        {...baseProps}
        currentLutName="VLog-Look.cube"
        lutProfileSelection={{
          status: 'recommended',
          fingerprint: 'vlog-look',
          title: 'VLog Look',
          recommendations: [vlog709],
        }}
        lutProfileResolution={{
          kind: 'recommended',
          recommendations: [vlog709],
        }}
      />,
    )

    const contractRegions = screen.getAllByRole('region', {
      name: 'LUT contract',
    })
    const contractRegion = contractRegions[0]
    const chooseOutputBtn = within(contractRegion).getByRole('button', {
      name: 'Choose output',
    })
    expect(chooseOutputBtn).toHaveAttribute('data-raw-lut', 'choose-output')

    await user.click(chooseOutputBtn)

    expect(
      screen.getByRole('dialog', { name: 'LUT contract browser' }),
    ).toBeInTheDocument()
  })
})
