import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { viewportWidthAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import { createMockExportResultIdentity } from '../model/export-result.fixture'
import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../state/tool-card.atoms'
import { LutDropzone } from './Dropzone'
import type { RawToolSurfaceFixtureProps } from './raw-tool-surface.fixture'
import { renderRawToolSurface } from './raw-tool-surface.fixture'
import { toolAvailabilityFixture } from './tool-availability.fixture'

const mockIdentity = createMockExportResultIdentity({
  source: { name: 'DSC09142.ARW', size: 1000, lastModified: 0 },
})

// Held to the surface contract, so a fixture cannot carry a field the
// surfaces no longer take.
const baseProps = {
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
  onIntensityChange: vi.fn(),
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onColorChange: vi.fn(),
  onColorReset: vi.fn(),
  onSelectiveColorChange: vi.fn(),
  onSelectiveColorReset: vi.fn(),
  onCompareReset: vi.fn(),
  viewMode: 'processed' as const,
  onViewModeChange: vi.fn(),
  onCompareSplitChange: vi.fn(),
  fileName: 'DSC09142.ARW',
  onReplaceFile: vi.fn(),
  onResetSession: vi.fn(),
  onLutLoad: vi.fn(),
  onLutClear: vi.fn(),
  onLutProfileSelect: vi.fn(),
  onExport: vi.fn(),
  canExport: false,
  disabledReason: {
    source: 'workflow' as const,
    reason: { code: 'source-loading' as const },
  },
  isProcessing: false,
  exportResult: null,
  exportShareCapability: {
    available: false as const,
    reasonCode: 'no-result',
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
} satisfies RawToolSurfaceFixtureProps

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
    loadedEntry: null,
    activateCatalogs: vi.fn(),
    resourceActivation: { 'source-1': 'ready' },
    catalogActivation: 'ready',
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
    // Unmount before the reset writes, so no store change reaches the surface.
    cleanup()
    vi.unstubAllGlobals()
    resetToolCards()
    localStorage.clear()
  })

  it('renders the finishing surface with a card stack and a persistent export block', () => {
    const { container } = renderRawToolSurface(baseProps)
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
    // The rail sits beside the photo: a solid plate, not glass.
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

  it('surfaces first profile LUT entries inline before opening the full catalog', async () => {
    const user = userEvent.setup()
    const fixture = withManyOnlineEntries(onlineLutSourcesFixture())
    renderRawToolSurface({ ...baseProps, onlineLutSources: fixture })

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

  it('drops the staged LUT hint once a RAW is loaded', () => {
    renderRawToolSurface({ ...baseProps, hasImage: true })

    expect(
      screen.queryByText(
        'Add a .cube LUT now, it stays staged until a RAW file is loaded.',
      ),
    ).toBeNull()
  })

  it('reveals the histogram plot when its card is expanded', async () => {
    const user = userEvent.setup()
    const luma = new Uint32Array(256)
    const red = new Uint32Array(256)
    luma[0] = 1
    luma[255] = 1
    red[0] = 1
    red[255] = 1

    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      histogram: {
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
      },
    })

    // The trigger meta speaks in shares of the frame, like the card body.
    await user.click(screen.getByRole('button', { name: 'Histogram' }))
    const regions = await screen.findAllByRole('region', { name: 'Histogram' })
    expect(regions.length).toBeGreaterThanOrEqual(1)
    expect(
      within(regions[0]).getByLabelText('Preview luminance and RGB histogram'),
    ).toBeInTheDocument()
  })

  it('shows unsupported histogram state without stale bins', async () => {
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      histogram: {
        state: 'unsupported',
        reason:
          'Built-in styles are not supported by full-resolution JPEG export.',
      },
    })

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
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      tone: {
        userExposureEv: 0,
        userContrast: 12,
        userHighlights: 0,
        userShadows: 0,
        userWhites: 0,
        userBlacks: 0,
      },
      onToneChange,
      onToneReset,
    })

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

    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      tone: { ...baseProps.tone, userContrast: 12 },
      color: {
        userTemperature: 18,
        userTint: 0,
        userSaturation: 0,
        userVibrance: 0,
      },
      onColorChange: vi.fn(),
      onColorReset,
      onToneReset,
    })

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
    renderRawToolSurface({ ...baseProps, hasImage: true })

    const adjust = screen.getByRole('region', { name: 'Adjust' })

    expect(
      within(adjust).getByRole('button', { name: 'Reset color' }),
    ).toBeDisabled()
  })

  it('disables reset tone when tone controls are neutral', () => {
    renderRawToolSurface({ ...baseProps, hasImage: true })

    const adjust = screen.getByRole('region', { name: 'Adjust' })

    expect(
      within(adjust).getByRole('button', { name: 'Reset tone' }),
    ).toBeDisabled()
  })

  it('disables tone controls before upload', async () => {
    renderRawToolSurface(baseProps)

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
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      previewSuspended: true,
    })

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
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      onCompareReset,
    })

    expect(
      screen.getByRole('button', { name: 'Reset tone' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compare' }))
    expect(
      screen.getByText('Drag the split directly on the image.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reset compare view' }))

    expect(onCompareReset).toHaveBeenCalledTimes(1)
  })

  it('disables desktop Compare reset where the stage has no split to reset', async () => {
    const user = userEvent.setup()
    const onCompareReset = vi.fn()
    const { rerender } = renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      compareSupported: false,
      onCompareReset,
    })

    await user.click(screen.getByRole('button', { name: 'Compare' }))
    const resetButton = screen.getByRole('button', {
      name: 'Reset compare view',
    })
    expect(resetButton).toBeDisabled()
    await user.click(resetButton)
    expect(onCompareReset).not.toHaveBeenCalled()

    // Back on a stage that can split, the reset is live again.
    rerender({
      ...baseProps,
      hasImage: true,
      compareSupported: true,
      onCompareReset,
    })
    expect(
      screen.getByRole('button', { name: 'Reset compare view' }),
    ).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Reset compare view' }))
    expect(onCompareReset).toHaveBeenCalledOnce()
  })

  it('locks the desktop rail from the availability it is handed, not its own flags', async () => {
    const user = userEvent.setup()
    // Facts that would leave every control open, and a policy that refuses
    // them: the policy is what the rail draws.
    const open = toolAvailabilityFixture({
      hasImage: true,
      currentLutName: 'look.cube',
    })
    const refused = {
      available: false as const,
      reason: 'export-running' as const,
    }
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      currentLutName: 'look.cube',
      toolAvailability: {
        ...open,
        desktop: {
          ...open.desktop,
          edit: refused,
          strength: refused,
          lutApplication: refused,
          splitReset: refused,
        },
      },
    })

    expect(
      within(getToneRegion()).getByRole('slider', { name: 'Exposure' }),
    ).toHaveAttribute('data-disabled')
    expect(screen.getByLabelText(/add \.cube lut/i)).toBeDisabled()
    expect(screen.getByRole('slider', { name: 'Strength' })).toHaveAttribute(
      'data-disabled',
    )
    await user.click(screen.getByRole('button', { name: 'Compare' }))
    expect(
      screen.getByRole('button', { name: 'Reset compare view' }),
    ).toBeDisabled()
  })

  it('sets a continuous strength on the desktop rail, with presets as detents', () => {
    const onChange = vi.fn()
    const { container } = renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      currentLutName: 'Sony Look.cube',
      activeIntensity: 0.62,
      onIntensityChange: onChange,
    })

    const row = container.querySelector<HTMLElement>(
      '[data-raw-desktop-strength="row"]',
    )!
    const strength = within(row).getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('aria-valuenow', '62')
    expect(strength).toHaveAttribute('aria-valuetext', '62%')
    // No segmented control is left behind.
    expect(screen.queryByRole('tablist', { name: 'Strength' })).toBeNull()
    expect(row.querySelector('[data-slider-tick-labels]')).toHaveTextContent(
      'LightStandardStrong',
    )

    // Arrows step 1%, Shift+arrows 10%.
    fireEvent.keyDown(strength, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith(0.63)
    fireEvent.keyDown(strength, { key: 'ArrowRight', shiftKey: true })
    expect(onChange).toHaveBeenLastCalledWith(0.72)

    // The amber value returns it to Standard.
    const reset = within(row).getByRole('button', { name: 'Reset Strength' })
    fireEvent.click(reset)
    expect(onChange).toHaveBeenLastCalledWith(0.7)
  })

  it('updates the strength from props without remounting the slider', () => {
    const { rerender } = renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      currentLutName: 'Sony Look.cube',
    })

    const strength = screen.getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('aria-valuetext', '70%')

    rerender({
      ...baseProps,
      hasImage: true,
      currentLutName: 'Sony Look.cube',
      activeIntensity: 0,
    })

    expect(screen.getByRole('slider', { name: 'Strength' })).toBe(strength)
    expect(strength).toHaveAttribute('aria-valuetext', 'Off')
  })

  it('keeps strength disabled for catalog-only online LUT sources and says why', () => {
    const onChange = vi.fn()
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      onlineLutSources: onlineLutSourcesFixture(),
      onIntensityChange: onChange,
    })

    const strength = screen.getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('data-disabled')
    expect(strength).toHaveAccessibleDescription(
      'Choose a LUT to set its strength',
    )
    fireEvent.keyDown(strength, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('disables strength but keeps LUT loading before upload', () => {
    const onChange = vi.fn()
    renderRawToolSurface({ ...baseProps, onIntensityChange: onChange })

    expect(screen.getByLabelText(/add \.cube lut/i)).toBeEnabled()

    const strength = screen.getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('data-disabled')
    expect(strength).not.toHaveAttribute('tabindex')
    fireEvent.keyDown(strength, { key: 'ArrowRight' })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows preserved tone state for non-neutral tone', () => {
    renderRawToolSurface({
      ...baseProps,
      hasImage: true,
      tone: {
        userExposureEv: 0,
        userContrast: 0,
        userHighlights: -40,
        userShadows: 40,
        userWhites: -20,
        userBlacks: 20,
      },
    })

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
    const { container } = renderRawToolSurface({
      ...baseProps,
      onlineLutSources: fixture,
    })

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
    renderRawToolSurface({
      ...baseProps,
      onlineLutSources: onlineLutSourcesFixture(),
    })

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
      renderRawToolSurface({
        ...baseProps,
        onlineLutSources: onlineLutSourcesFixture({ loadEntry }),
      })

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

  it('keeps manual upload visible beside online source controls', () => {
    renderRawToolSurface({
      ...baseProps,
      onlineLutSources: onlineLutSourcesFixture(),
    })

    expect(screen.getByLabelText(/add \.cube lut/i)).toBeInTheDocument()
  })

  it('reflects online LUT share availability on the share button', () => {
    const { rerender } = renderRawToolSurface({
      ...baseProps,
      onlineLutSources: onlineLutSourcesFixture({
        share: {
          enabled: false,
          url: '/raw',
          copy: vi.fn().mockResolvedValue(undefined),
        },
      }),
    })

    expect(
      screen.getByRole('button', { name: 'Copy LUT source link' }),
    ).toBeDisabled()

    rerender({ ...baseProps, onlineLutSources: onlineLutSourcesFixture() })

    expect(
      screen.getByRole('button', { name: 'Copy LUT source link' }),
    ).toBeEnabled()
  })

  it('marks the LUT contract status and its change control', () => {
    renderRawToolSurface({
      ...baseProps,
      currentLutName: 'Unknown Look.cube',
      lutProfileSelection: {
        status: 'unknown',
        fingerprint: 'lut-contract-materials',
        title: 'Unknown Look',
      },
      lutProfileResolution: {
        kind: 'unknown',
      },
    })

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toHaveAttribute('data-raw-lut', 'contract-status')
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toHaveAttribute('data-raw-lut', 'contract-change-button')
  })

  it('shows a busy refresh affordance while an online LUT source is loading', () => {
    renderRawToolSurface({
      ...baseProps,
      onlineLutSources: onlineLutSourcesFixture({
        state: {
          ...onlineLutSourcesFixture().state,
          entries: [],
          activeResourceId: 'source-1',
          isLoading: true,
        },
        resourceActivation: { 'source-1': 'loading' },
        catalogActivation: 'loading',
      }),
    })

    const refresh = screen.getByRole('button', {
      name: 'Refresh Catalog from profiles.example.com',
    })

    expect(refresh).toHaveAttribute('aria-busy', 'true')
    expect(refresh).toHaveAttribute('data-raw-lut-busy', 'true')
    expect(screen.getByText('Loading')).toBeInTheDocument()
  })

  it('announces a translated online LUT source issue summary as a status update', () => {
    renderRawToolSurface({
      ...baseProps,
      onlineLutSources: onlineLutSourcesFixture({
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
      }),
    })

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

  it('mobile + no image shows onboarding under the branded topbar, without a dock', () => {
    const prev = jotaiStore.get(viewportWidthAtom)
    jotaiStore.set(viewportWidthAtom, 390)
    try {
      const { container } = renderRawToolSurface({
        ...baseProps,
        hasImage: false,
      })
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
        screen.getByRole('button', { name: /browse raw files/i }),
      ).toBeInTheDocument()
      expect(
        container.querySelector('[data-mobile-topbar]'),
      ).toBeInTheDocument()
      // The dock only arrives with a RAW to act on.
      expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()
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
      cleanup()
      jotaiStore.set(viewportWidthAtom, prev)
    }
  })

  it('mobile + image mounts the photo-first chrome', () => {
    const prev = jotaiStore.get(viewportWidthAtom)
    jotaiStore.set(viewportWidthAtom, 390)
    try {
      const { container } = renderRawToolSurface({
        ...baseProps,
        hasImage: true,
      })
      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        screen.getByRole('tablist', { name: /lab modes/i }).parentElement,
      ).toHaveClass('pointer-events-auto')
    } finally {
      cleanup()
      jotaiStore.set(viewportWidthAtom, prev)
    }
  })

  it('mobile keeps strength disabled for catalog-only online LUT sources', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const prev = jotaiStore.get(viewportWidthAtom)
    jotaiStore.set(viewportWidthAtom, 390)
    try {
      renderRawToolSurface({
        ...baseProps,
        hasImage: true,
        onlineLutSources: onlineLutSourcesFixture(),
        onIntensityChange: onChange,
      })

      const dock = screen.getByRole('tablist', { name: /lab modes/i })
      expect(within(dock).getAllByRole('tab')).toHaveLength(2)
      expect(
        within(dock).queryByRole('tab', { name: /strength/i }),
      ).not.toBeInTheDocument()

      // Strength lives in the Look deck; it stays off until a LUT applies.
      const strength = screen.getByRole('slider', { name: 'Strength' })
      expect(strength).toHaveAttribute('data-disabled')
      expect(strength).toHaveAccessibleDescription(
        'Choose a LUT to set its strength',
      )

      await user.keyboard('{ArrowRight}')
      fireEvent.keyDown(strength, { key: 'ArrowRight' })

      expect(onChange).not.toHaveBeenCalled()
    } finally {
      cleanup()
      jotaiStore.set(viewportWidthAtom, prev)
    }
  })

  it('mobile lets the stage handoff receive touch while processing', () => {
    const prev = jotaiStore.get(viewportWidthAtom)
    jotaiStore.set(viewportWidthAtom, 390)
    try {
      const { container } = renderRawToolSurface({
        ...baseProps,
        hasImage: true,
        isProcessing: true,
      })

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
      cleanup()
      jotaiStore.set(viewportWidthAtom, prev)
    }
  })

  it('mobile locks the tools while the preview is released, and keeps every delivery action on the result', async () => {
    const user = userEvent.setup()
    const prev = jotaiStore.get(viewportWidthAtom)
    jotaiStore.set(viewportWidthAtom, 390)
    const onToneChange = vi.fn()
    const onDownloadExport = vi.fn()
    const onDownloadExportManifest = vi.fn()
    const onShareExport = vi.fn()
    const onCopyExport = vi.fn()
    const delivered = {
      ...baseProps,
      hasImage: true,
      canExport: true,
      disabledReason: undefined,
      onToneChange,
      onDownloadExport,
      onDownloadExportManifest,
      onShareExport,
      onCopyExport,
      exportResult: {
        kind: 'full-resolution' as const,
        identity: mockIdentity,
        output: {
          kind: 'blob' as const,
          filename: 'DSC09142_fullres.jpg',
          blob: new Blob(['jpeg'], { type: 'image/jpeg' }),
          byteLength: 4,
          mimeType: 'image/jpeg' as const,
        },
        filename: 'DSC09142_fullres.jpg',
        width: 6000,
        height: 4000,
        size: 4,
        createdAt: 0,
        copyCapability: {
          mode: 'preview-size' as const,
          reasonCode: 'full-resolution-copy-unsupported' as const,
        },
        manifestState: { status: 'ready' as const },
      },
      exportShareCapability: { available: true as const },
    }
    try {
      const { container, rerender } = renderRawToolSurface({
        ...delivered,
        previewSuspended: true,
      })
      const dock = screen.getByRole('tablist', { name: /lab modes/i })
      for (const tab of within(dock).getAllByRole('tab')) {
        expect(tab).toBeDisabled()
      }

      // The result opens on its own, and every delivery action works.
      await user.click(await screen.findByRole('button', { name: 'Download' }))
      await user.click(
        screen.getByRole('button', { name: 'Download render manifest (JSON)' }),
      )
      await user.click(screen.getByRole('button', { name: 'Share' }))
      await user.click(
        screen.getByRole('button', { name: 'Copy preview-size image' }),
      )
      expect(onDownloadExport).toHaveBeenCalledOnce()
      expect(onDownloadExportManifest).toHaveBeenCalledOnce()
      expect(onShareExport).toHaveBeenCalledOnce()
      expect(onCopyExport).toHaveBeenCalledOnce()

      // Closing it reveals no tool; the topbar Export opens it again.
      await user.click(screen.getByRole('button', { name: 'Close export' }))
      expect(screen.queryByRole('button', { name: 'Download' })).toBeNull()
      expect(screen.queryByRole('slider')).toBeNull()
      await user.click(
        container.querySelector<HTMLButtonElement>(
          '[data-mobile-export-action]',
        )!,
      )
      expect(
        screen.getByRole('button', { name: 'Download' }),
      ).toBeInTheDocument()

      // Restored, the tools edit again.
      rerender(delivered)
      await user.click(within(dock).getByRole('tab', { name: /adjust/i }))
      fireEvent.keyDown(screen.getByRole('slider', { name: 'Exposure' }), {
        key: 'ArrowRight',
      })
      expect(onToneChange).toHaveBeenCalled()
    } finally {
      cleanup()
      jotaiStore.set(viewportWidthAtom, prev)
    }
  })
})
