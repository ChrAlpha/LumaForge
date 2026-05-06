import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
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
  onIntensitySelect: vi.fn(),
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onCompareReset: vi.fn(),
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
    loadEntry: vi.fn(),
    share: {
      enabled: true,
      url: '/raw?luts=https%3A%2F%2Fprofiles.example.com%2Freleases%2Fv2026.05.01%2Fcatalog.json',
      copy: vi.fn(),
    },
    ...overrides,
  }
}

function setWindowSize(width: number, height: number) {
  const previousWidth = window.innerWidth
  const previousHeight = window.innerHeight

  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: height,
  })

  return () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: previousWidth,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: previousHeight,
    })
  }
}

describe('rawToolSurface', () => {
  it('groups controls as a RAW finishing surface instead of a legacy panel', () => {
    const { container } = render(<RawToolSurface {...baseProps} />)

    expect(
      container.querySelector('[data-raw-panel="controls"]'),
    ).not.toBeInTheDocument()
    expect(
      container.querySelector('[data-raw-tool-surface="raw-finishing"]'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'LUT contract' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Strength' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Compare' })).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: 'JPEG presets' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Neutral' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Warm' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Export' })).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: 'File facts' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Choose a RAW to use JPEG presets.'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText('Full-resolution export source is still loading.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Export full-resolution JPEG' }),
    ).toHaveClass('bg-[color:--color-raw-green]')
  })

  it('renders strength controls before tone', async () => {
    render(<RawToolSurface {...baseProps} hasImage />)

    const tone = screen.getByRole('region', { name: 'Tone' })
    const strength = screen.getByRole('region', { name: 'Strength' })

    expect(within(tone).getByLabelText('Exposure')).toBeInTheDocument()
    for (const label of [
      'Contrast',
      'Highlights',
      'Shadows',
      'Whites',
      'Blacks',
    ]) {
      expect(within(tone).getByLabelText(label)).toBeInTheDocument()
    }
    expect(screen.getByRole('region', { name: 'Tone' })).toBeInTheDocument()
    expect(
      strength.compareDocumentPosition(tone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('renders histogram near tone controls', () => {
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

    const tone = screen.getByRole('region', { name: 'Tone' })
    const histogram = screen.getByRole('region', { name: 'Histogram' })
    const strength = screen.getByRole('region', { name: 'Strength' })

    expect(
      strength.compareDocumentPosition(tone) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      tone.compareDocumentPosition(histogram) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(within(histogram).getByText('Quick preview')).toBeInTheDocument()
    expect(
      within(histogram).getByLabelText('Preview luminance and RGB histogram'),
    ).toBeInTheDocument()
    expect(
      histogram.querySelectorAll('.raw-histogram-channel-fill'),
    ).toHaveLength(3)
    expect(
      histogram.querySelectorAll('.raw-histogram-channel-line'),
    ).toHaveLength(1)
    expect(
      histogram.querySelector('.raw-histogram-channel-line-red'),
    ).toBeInTheDocument()
    expect(
      histogram.querySelector('.raw-histogram-channel-line-green'),
    ).not.toBeInTheDocument()
    expect(
      histogram.querySelector('.raw-histogram-channel-line-blue'),
    ).not.toBeInTheDocument()
    expect(histogram.querySelector('.raw-histogram-luma')).toBeInTheDocument()
    expect(within(histogram).getByText('Shadows 1')).toBeInTheDocument()
    expect(within(histogram).getByText('Highlights 1')).toBeInTheDocument()
  })

  it('shows unsupported histogram state without stale bins', () => {
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

    const histogram = screen.getByRole('region', { name: 'Histogram' })

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
          userContrast: 0,
          userHighlights: 0,
          userShadows: 0,
          userWhites: 0,
          userBlacks: 0,
        }}
        onToneChange={onToneChange}
        onToneReset={onToneReset}
      />,
    )

    fireEvent.change(screen.getByLabelText('Exposure'), {
      target: { value: '1.25' },
    })
    expect(onToneChange).toHaveBeenLastCalledWith({ userExposureEv: 1.25 })
    fireEvent.change(screen.getByLabelText('Highlights'), {
      target: { value: '-40' },
    })
    expect(onToneChange).toHaveBeenLastCalledWith({ userHighlights: -40 })

    await user.click(screen.getByRole('button', { name: 'Reset tone' }))
    expect(onToneReset).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole('button', { name: 'Reset tone' }),
    ).toBeInTheDocument()
  })

  it('disables tone controls before upload', () => {
    render(<RawToolSurface {...baseProps} />)

    expect(screen.getByLabelText('Exposure')).toBeDisabled()
    expect(screen.getByLabelText('Contrast')).toBeDisabled()
    expect(screen.getByLabelText('Highlights')).toBeDisabled()
    expect(screen.getByLabelText('Shadows')).toBeDisabled()
    expect(screen.getByLabelText('Whites')).toBeDisabled()
    expect(screen.getByLabelText('Blacks')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reset tone' })).toBeDisabled()
  })

  it('uses Raw Lab-specific reset controls for tone and compare', () => {
    render(<RawToolSurface {...baseProps} hasImage />)

    expect(
      screen.getByRole('button', { name: 'Reset tone' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Reset compare view' }),
    ).toBeInTheDocument()
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

  it('opens mobile tools from the bottom action rail without relying on page scroll', async () => {
    const user = userEvent.setup()
    const { container } = render(<RawToolSurface {...baseProps} />)

    const surface = container.querySelector('[data-raw-tool-surface]')
    const style = screen.getByRole('button', { name: 'Style' })

    expect(surface).toHaveAttribute('data-raw-tool-sheet', 'closed')
    expect(style).toHaveAttribute('aria-expanded', 'false')

    await user.click(style)
    expect(surface).toHaveAttribute('data-raw-tool-sheet', 'open')
    expect(surface).toHaveAttribute('data-raw-mobile-panel', 'style')
    expect(style).toHaveAttribute('aria-expanded', 'true')

    await user.click(style)
    expect(surface).toHaveAttribute('data-raw-tool-sheet', 'closed')
    expect(style).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the Export sheet on tap without triggering export', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    const { container } = render(
      <RawToolSurface {...baseProps} hasImage canExport onExport={onExport} />,
    )

    await user.click(screen.getByRole('button', { name: 'Export' }))

    expect(onExport).not.toHaveBeenCalled()
    expect(container.querySelector('[data-raw-mobile-panel]')).toHaveAttribute(
      'data-raw-mobile-panel',
      'export',
    )
    expect(
      within(
        container.querySelector('[data-raw-mobile-sheet]') as HTMLElement,
      ).getByRole('region', { name: 'Export' }),
    ).toBeInTheDocument()
  })

  it('triggers quick export on long press of the Export rail tab', async () => {
    const user = userEvent.setup()
    const onExport = vi.fn()
    render(
      <RawToolSurface {...baseProps} hasImage canExport onExport={onExport} />,
    )

    const exportTab = screen.getByRole('button', { name: 'Export' })
    await user.pointer({ keys: '[MouseLeft>]', target: exportTab })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await user.pointer({ keys: '[/MouseLeft]' })

    expect(onExport).toHaveBeenCalledWith({
      quality: 'high',
      fidelity: 'balanced',
    })
  })

  it('keeps long LUT names inside the tool column while preserving the full name', () => {
    const currentLut =
      'Fujifilm-GFX100RF-F-Log2C-to-Classic-Negative-Rec709-Display-Extremely-Long-Client-Delivery-Name.cube'

    render(<LutDropzone currentLut={currentLut} onFileDrop={vi.fn()} />)

    const label = screen.getByLabelText(/add \.cube lut/i)
    const frame = label.closest('label')
    const fileName = screen.getByText(currentLut)
    const row = fileName.parentElement?.parentElement

    expect(row).toHaveClass('min-w-0')
    expect(frame).toHaveClass('min-w-0', 'flex-1')
    expect(fileName).toHaveClass('min-w-0', 'truncate')
    expect(fileName).toHaveAttribute('title', currentLut)
  })

  it('renders online LUT sources as collapsed summary rows by default', () => {
    const { container } = render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    expect(
      screen.getByText('Catalog from profiles.example.com'),
    ).toBeInTheDocument()
    expect(screen.getByText('1 LUT')).toBeInTheDocument()
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

    expect(screen.queryByText('Kodak 2383 Rec.709')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load Kodak 2383 Rec.709' }),
    ).not.toBeInTheDocument()
    expect(container.querySelector('.raw-lut-source-entry')).toBeNull()
  })

  it('opens online LUT entries in a floating browser with compact rows', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )

    const open = screen.getByRole('button', {
      name: 'Open Catalog from profiles.example.com',
    })

    expect(open).toHaveAttribute('aria-haspopup', 'dialog')
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(open).toHaveAttribute('aria-controls')

    await user.click(open)

    const browser = screen.getByRole('dialog', {
      name: 'Catalog from profiles.example.com LUTs',
    })
    const browserList = browser.querySelector('[data-lut-source-scroll]')

    expect(open).toHaveAttribute('aria-expanded', 'true')
    expect(open).toHaveAttribute('aria-controls', browser.id)
    expect(
      within(browser).getByRole('button', {
        name: 'Close LUT source browser',
      }),
    ).toHaveFocus()
    expect(browser).toHaveAttribute('data-raw-lut-browser-dialog', 'source')
    expect(browser).toHaveClass('fixed', 'z-60')
    expect(browser).toHaveAttribute('data-lut-source-placement', 'anchored')
    expect(
      browser.style.getPropertyValue('--raw-lut-source-browser-top'),
    ).not.toBe('')
    expect(browserList).toHaveAttribute('data-lut-source-scroll', 'internal')
    expect(browser.closest('.raw-lut-source-controls')).toBeNull()
    expect(
      container.querySelector(
        '.raw-lut-source-controls .raw-lut-source-resource .raw-lut-source-entry',
      ),
    ).toBeNull()

    expect(within(browser).getByText('Kodak 2383 Rec.709')).toBeInTheDocument()
    expect(
      within(browser).getAllByText('Catalog from profiles.example.com'),
    ).toHaveLength(1)
    expect(
      within(browser).getByRole('button', {
        name: 'Load Kodak 2383 Rec.709',
      }),
    ).toBeInTheDocument()

    const entryRow = within(browser)
      .getByText('Kodak 2383 Rec.709')
      .closest('[class*="grid grid-cols"]')
    expect(entryRow).not.toBeNull()
    const entry = within(entryRow as HTMLElement)

    expect(entry.queryByText(/input contract/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/output contract/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/license/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/cache/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/sha256/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/hash/i)).not.toBeInTheDocument()
    expect(entry.queryByText(/12\s*bytes/i)).not.toBeInTheDocument()
  })

  it('docks the online LUT browser inside a short desktop viewport', async () => {
    const restoreWindowSize = setWindowSize(980, 420)
    const user = userEvent.setup()

    try {
      render(
        <RawToolSurface
          {...baseProps}
          onlineLutSources={onlineLutSourcesFixture()}
        />,
      )

      const open = screen.getByRole('button', {
        name: 'Open Catalog from profiles.example.com',
      })
      const rect = {
        bottom: 362,
        height: 32,
        left: 900,
        right: 932,
        top: 330,
        width: 32,
        x: 900,
        y: 330,
        toJSON: () => ({}),
      } satisfies DOMRect
      const getRect = vi
        .spyOn(open, 'getBoundingClientRect')
        .mockReturnValue(rect)

      await user.click(open)

      const browser = screen.getByRole('dialog', {
        name: 'Catalog from profiles.example.com LUTs',
      })

      expect(browser).toHaveAttribute('data-lut-source-placement', 'docked')
      expect(
        browser.style.getPropertyValue('--raw-lut-source-browser-top'),
      ).toBe('12px')
      expect(
        browser.style.getPropertyValue('--raw-lut-source-browser-max-height'),
      ).toBe('396px')

      getRect.mockRestore()
    } finally {
      restoreWindowSize()
    }
  })

  it('opens above the trigger when the upper viewport has more room', async () => {
    const restoreWindowSize = setWindowSize(980, 700)
    const user = userEvent.setup()

    try {
      render(
        <RawToolSurface
          {...baseProps}
          onlineLutSources={onlineLutSourcesFixture()}
        />,
      )

      const open = screen.getByRole('button', {
        name: 'Open Catalog from profiles.example.com',
      })
      const rect = {
        bottom: 462,
        height: 32,
        left: 900,
        right: 932,
        top: 430,
        width: 32,
        x: 900,
        y: 430,
        toJSON: () => ({}),
      } satisfies DOMRect
      const getRect = vi
        .spyOn(open, 'getBoundingClientRect')
        .mockReturnValue(rect)

      await user.click(open)

      const browser = screen.getByRole('dialog', {
        name: 'Catalog from profiles.example.com LUTs',
      })

      expect(browser).toHaveAttribute('data-lut-source-placement', 'anchored')
      expect(
        browser.style.getPropertyValue('--raw-lut-source-browser-top'),
      ).toBe('12px')
      expect(
        browser.style.getPropertyValue('--raw-lut-source-browser-max-height'),
      ).toBe('410px')

      getRect.mockRestore()
    } finally {
      restoreWindowSize()
    }
  })

  it('uses a bottom sheet placement for online LUT browsing on mobile widths', async () => {
    const restoreWindowSize = setWindowSize(390, 640)
    const user = userEvent.setup()

    try {
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

      const browser = screen.getByRole('dialog', {
        name: 'Catalog from profiles.example.com LUTs',
      })

      expect(browser).toHaveAttribute('data-lut-source-placement', 'sheet')
      expect(
        browser.style.getPropertyValue('--raw-lut-source-browser-top'),
      ).toBe('')
    } finally {
      restoreWindowSize()
    }
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

    await user.click(document.body)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(open).toHaveFocus()
  })

  it('closes the online LUT browser when its trigger is clicked again', async () => {
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
    expect(
      screen.getByRole('dialog', {
        name: 'Catalog from profiles.example.com LUTs',
      }),
    ).toBeInTheDocument()

    await user.click(open)

    expect(
      screen.queryByRole('dialog', {
        name: 'Catalog from profiles.example.com LUTs',
      }),
    ).not.toBeInTheDocument()
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(open).toHaveFocus()
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
          share: { enabled: false, url: '/raw', copy: vi.fn() },
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
          status: 'pending',
          fingerprint: 'lut-contract-materials',
          title: 'Unknown Look',
          suggestions: [],
        }}
        lutProfileResolution={{
          kind: 'needs-user-selection',
          suggestions: [],
        }}
      />,
    )

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toHaveClass('to-[color:--color-raw-amber-soft]')
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toHaveClass('bg-[color:oklch(0.934_0.03_84_/_0.92)]')
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
    expect(refresh).toHaveClass('[&_svg]:animate-spin')
    expect(screen.getByText('Loading')).toBeInTheDocument()
  })

  it('announces online LUT source issues as status updates', () => {
    render(
      <RawToolSurface
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture({
          state: {
            ...onlineLutSourcesFixture().state,
            issues: [
              {
                code: 'network',
                message: 'Failed to fetch online profile resource.',
                resourceId: 'source-1',
              },
            ],
          },
        })}
      />,
    )

    const status = screen.getByRole('status')

    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveTextContent('Failed to fetch online profile resource.')
    expect(screen.getByText('Issue')).toBeInTheDocument()
  })
})
