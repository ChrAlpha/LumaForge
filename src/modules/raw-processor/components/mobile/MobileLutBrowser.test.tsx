import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { MobileLutBrowser } from './MobileLutBrowser'

const baseProps = {
  open: true,
  onClose: vi.fn(),
  currentLutName: 'Kodak 2383.cube',
  disabled: false,
  onLutLoad: vi.fn(),
  onLutClear: vi.fn(),
  lutProfileSelection: null,
  lutProfileResolution: null,
  onLutProfileSelect: vi.fn(),
  activeIntensity: 'standard' as const,
  onIntensitySelect: vi.fn(),
  strengthDisabled: false,
}

function onlineLutSourcesFixture(
  loadEntry = vi.fn(async (): Promise<'loaded'> => 'loaded'),
): UseOnlineLutSourcesResult {
  return {
    state: {
      resources: [
        {
          id: 'source-1',
          url: 'https://profiles.example.com/catalog.json',
          type: 'catalog',
          label: 'Profiles catalog',
          fromQuery: true,
        },
      ],
      entries: [
        {
          id: 'kodak-2383-rec709',
          resourceId: 'source-1',
          title: 'Kodak 2383 Rec.709',
          sourceUrl: 'https://profiles.example.com/kodak-2383-rec709.json',
          sourceType: 'catalog-entry',
          cube: {
            url: 'https://profiles.example.com/kodak-2383-rec709.cube',
            sha256:
              '9c56cc51b374c3ba189210d5b6d4bf57790d351c96c47c02190ecf1e430635ab',
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
    loadEntry,
    loadingEntryId: null,
    failedEntryId: null,
    entryLoadProgress: null,
    cancelEntryLoad: vi.fn(),
    share: {
      enabled: false,
      url: '',
      copy: vi.fn().mockResolvedValue(undefined),
    },
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
        sourceUrl: 'https://profiles.example.com/ektachrome-e100.json',
        cube: {
          ...firstEntry.cube,
          title: 'Ektachrome E100',
          url: 'https://profiles.example.com/ektachrome-e100.cube',
        },
      },
      {
        ...firstEntry,
        id: 'portra-400',
        title: 'Portra 400',
        sourceUrl: 'https://profiles.example.com/portra-400.json',
        cube: {
          ...firstEntry.cube,
          title: 'Portra 400',
          url: 'https://profiles.example.com/portra-400.cube',
        },
      },
      {
        ...firstEntry,
        id: 'vision3-250d',
        title: 'Vision3 250D',
        sourceUrl: 'https://profiles.example.com/vision3-250d.json',
        cube: {
          ...firstEntry.cube,
          title: 'Vision3 250D',
          url: 'https://profiles.example.com/vision3-250d.cube',
        },
      },
      {
        ...firstEntry,
        id: 'velvia-50',
        title: 'Velvia 50',
        sourceUrl: 'https://profiles.example.com/velvia-50.json',
        cube: {
          ...firstEntry.cube,
          title: 'Velvia 50',
          url: 'https://profiles.example.com/velvia-50.cube',
        },
      },
    ],
  }

  return fixture
}

describe('mobileLutBrowser', () => {
  beforeEach(() => {
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
    vi.clearAllMocks()
  })

  it('renders the dialog with the current LUT and closes via the close button', async () => {
    const onClose = vi.fn()
    render(<MobileLutBrowser {...baseProps} onClose={onClose} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('data-mobile-substrate', 'ink-sheet')
    expect(dialog).toHaveClass('bg-gradient-to-t')
    expect(dialog).toHaveClass('from-[oklch(0.092_0.006_255/0.96)]')
    expect(dialog).not.toHaveClass('from-black/92')
    expect(dialog).not.toHaveClass('to-lf-darkroom-stage-low/94')
    expect(dialog).toHaveClass('text-lf-on-photo-ink')
    expect(dialog).toHaveClass('border-lf-on-photo-bord-soft')
    expect(dialog).not.toHaveClass('bg-lf-surface-raised')
    expect(dialog).not.toHaveClass('text-lf-on-surface')
    expect(dialog.className).not.toMatch(
      /bg-material|bg-background|bg-fill|text-text|border-border/,
    )
    expect(screen.getByText('Kodak 2383.cube')).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: /close lut browser/i }),
    )

    expect(onClose).toHaveBeenCalled()
  })

  it('clears the current LUT', async () => {
    const onLutClear = vi.fn()
    render(<MobileLutBrowser {...baseProps} onLutClear={onLutClear} />)

    await userEvent.click(screen.getByRole('button', { name: /clear lut/i }))

    expect(onLutClear).toHaveBeenCalled()
  })

  it('uses Add .cube LUT as the empty Current LUT card state', () => {
    render(<MobileLutBrowser {...baseProps} currentLutName={null} />)

    const currentSection = screen
      .getByRole('heading', { name: 'Current LUT' })
      .closest('section')
    expect(currentSection).toHaveAttribute('data-raw-mobile-lut', 'current')
    const currentCard = within(currentSection!).getByTestId(
      'raw-mobile-current-lut-card',
    )
    expect(
      within(currentCard).getByLabelText('Upload .cube LUT'),
    ).toBeInTheDocument()
    expect(within(currentCard).getByText('Add .cube LUT')).toBeVisible()
    expect(within(currentCard).queryByText('-')).not.toBeInTheDocument()
    expect(
      within(currentCard).queryByText('Choose .cube LUT'),
    ).not.toBeInTheDocument()
    expect(
      within(currentCard).queryByText('Tap to browse or drop a file'),
    ).not.toBeInTheDocument()
    expect(
      within(currentCard).queryByRole('button', { name: 'Clear LUT' }),
    ).not.toBeInTheDocument()
    expect(
      within(currentCard).getByLabelText('Upload .cube LUT').closest('label'),
    ).not.toHaveClass('border-2')
    expect(
      within(currentCard).getByLabelText('Upload .cube LUT').closest('label'),
    ).not.toHaveClass('border-dashed')
    expect(
      within(currentCard).getByLabelText('Upload .cube LUT').closest('label'),
    ).not.toHaveClass('border-t')
    expect(
      screen.queryByRole('heading', { name: 'Upload .cube' }),
    ).not.toBeInTheDocument()
  })

  it('uses the selected LUT name and Clear action as the loaded Current LUT card state', () => {
    render(<MobileLutBrowser {...baseProps} />)

    const currentSection = screen
      .getByRole('heading', { name: 'Current LUT' })
      .closest('section')
    const currentCard = within(currentSection!).getByTestId(
      'raw-mobile-current-lut-card',
    )

    expect(within(currentCard).getByText('Kodak 2383.cube')).toBeVisible()
    expect(
      within(currentCard).getByRole('button', { name: 'Clear LUT' }),
    ).toBeEnabled()
    expect(
      within(currentCard).queryByText('Add .cube LUT'),
    ).not.toBeInTheDocument()
  })

  it('renders strength in overview and disables it when requested', () => {
    render(
      <MobileLutBrowser
        {...baseProps}
        currentLutName={null}
        strengthDisabled
      />,
    )

    const strengthSection = screen
      .getByRole('heading', { name: 'Strength' })
      .closest('section')

    expect(strengthSection).toHaveAttribute('data-raw-mobile-lut', 'strength')
    // Section itself is a clean wrapper; the track carries the local mobile
    // substrate. Keep the LUT sheet in the dark on-photo family instead of
    // importing the desktop paper surface.
    expect(strengthSection?.className ?? '').not.toMatch(/bg-\[oklch/)
    expect(strengthSection?.className ?? '').not.toMatch(/bg-lf-surface-muted/)

    const tablist = screen.getByRole('tablist', { name: 'Strength' })
    expect(tablist).toBeInTheDocument()
    // Borderless track per §6 Inset Hairline Rule — the track defines its
    // edge by a 5% cool-white fill against the chrome surface, not a drawn
    // hairline. This keeps the segmented control from reading heavier on
    // the flatter mobile sheet than on the structured desktop tool card.
    expect(tablist.className).toMatch(/bg-\[oklch\(0\.96_0\.006_255\/0\.05\)\]/)
    expect(tablist).not.toHaveClass('border-lf-on-photo-bord-soft')
    expect(tablist).not.toHaveClass('bg-lf-on-photo-bg')
    expect(tablist).not.toHaveClass('bg-lf-surface-muted/55')
    expect(tablist).not.toHaveClass('border-lf-hairline/45')
    expect(tablist.className).not.toMatch(
      /bg-\[oklch\(from_var\(--color-lf-on-surface\)/,
    )
    // The active segment renders a motion-animated thumb (layoutId-driven
    // spring) and earns the cool-white wash + top highlight that matches
    // the rest of the chrome's seam idiom (oklch(0.96 0.006 255 / *)).
    const standardTab = screen.getByRole('tab', { name: 'Standard' })
    expect(standardTab.querySelector('[data-segment-thumb]')).not.toBeNull()
    // Active-thumb wash: 10% cool-white, brighter than the 5% track wash so
    // the segment lifts visibly without depending on a drawn outline.
    expect(standardTab.className).toMatch(
      /data-\[state=active\]:\[&_span\[data-segment-thumb\]\]:bg-\[oklch\(0\.96_0\.006_255\/0\.10\)\]/,
    )
    // Weight contrast carries the readability when the bg delta is subtle.
    expect(standardTab.className).toMatch(/data-\[state=active\]:font-semibold/)
    expect(standardTab.className).toMatch(
      /data-\[state=active\]:text-lf-on-photo-ink/,
    )
    expect(standardTab.className).not.toMatch(/bg-lf-surface-raised/)
    expect(standardTab.className).not.toMatch(/bg-lf-on-photo-bg-strong/)
    expect(standardTab).toBeDisabled()
  })

  it('opens a source catalog, loads an online LUT entry, and returns to overview', async () => {
    const loadEntry = vi.fn().mockResolvedValue('loaded' as const)
    render(
      <MobileLutBrowser
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture(loadEntry)}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-mobile-lut-view',
      'overview',
    )

    await userEvent.click(
      screen.getByRole('button', { name: /open profiles catalog/i }),
    )

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-mobile-lut-view',
      'catalog',
    )
    expect(
      screen.queryByRole('button', { name: /open profiles catalog/i }),
    ).toBeNull()

    await userEvent.click(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    )
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709')
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toHaveAttribute(
        'data-mobile-lut-view',
        'overview',
      )
    })
  })

  it('surfaces first profile LUT entries inline in the overview', async () => {
    const loadEntry = vi.fn().mockResolvedValue(undefined)
    render(
      <MobileLutBrowser
        {...baseProps}
        onlineLutSources={withManyOnlineEntries(
          onlineLutSourcesFixture(loadEntry),
        )}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-mobile-lut-view',
      'overview',
    )

    await userEvent.click(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    )
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709')
    expect(screen.queryByText('Velvia 50')).not.toBeInTheDocument()
    // The source card's FolderOpen button is the only path into the catalog
    // view; the inline strip stays preview-only so 5+ entries don't fight for
    // a redundant "Browse all" pill at the end of the scroller.
    expect(
      screen.getByRole('button', { name: /open profiles catalog/i }),
    ).toBeInTheDocument()
  })

  it('acks the mobile LUT entry load click before the load resolves', async () => {
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
        <MobileLutBrowser
          {...baseProps}
          onlineLutSources={onlineLutSourcesFixture(loadEntry)}
        />,
      )

      await userEvent.click(
        screen.getByRole('button', { name: /open profiles catalog/i }),
      )

      const loadButton = screen.getByRole('button', {
        name: /load kodak 2383 rec.709/i,
      })
      expect(loadButton).not.toHaveAttribute('aria-busy', 'true')

      await userEvent.click(loadButton)

      expect(
        await screen.findByRole('button', {
          name: /cancel download of kodak 2383 rec\.709/i,
          busy: true,
        }),
      ).toBeInTheDocument()
      expect(loadEntry).not.toHaveBeenCalled()

      const queued = rafQueue.splice(0)
      await act(async () => {
        for (const callback of queued) callback(performance.now())
        await Promise.resolve()
      })

      expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709')

      await act(async () => {
        loadHandle.resolve?.()
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('lets the user add an online LUT source URL from the mobile sheet', async () => {
    const fixture = onlineLutSourcesFixture()
    fixture.sourceUrlInput = 'https://profiles.example.com/extra.json'
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    const input = screen.getByLabelText(/online lut source url/i)
    await userEvent.click(input)
    await userEvent.keyboard('{Enter}')

    expect(fixture.addSourceFromInput).toHaveBeenCalledTimes(1)

    await userEvent.click(
      screen.getByRole('button', { name: /add lut source/i }),
    )

    expect(fixture.addSourceFromInput).toHaveBeenCalledTimes(2)
  })

  it('disables the add button when the online LUT source URL is empty', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.sourceUrlInput = ''
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByRole('button', { name: /add lut source/i }),
    ).toBeDisabled()
  })

  it('refreshes an online LUT source from the mobile sheet', async () => {
    const fixture = onlineLutSourcesFixture()
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    await userEvent.click(
      screen.getByRole('button', { name: /refresh profiles catalog/i }),
    )

    expect(fixture.refreshSource).toHaveBeenCalledWith('source-1')
  })

  it('removes an online LUT source from the mobile sheet', async () => {
    const fixture = onlineLutSourcesFixture()
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    await userEvent.click(
      screen.getByRole('button', { name: /remove profiles catalog/i }),
    )

    expect(fixture.removeSource).toHaveBeenCalledWith('source-1')
  })

  it('marks the active resource as loading and disables its refresh button', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      ...fixture.state,
      isLoading: true,
      activeResourceId: 'source-1',
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    const refreshButton = screen.getByRole('button', {
      name: /refresh profiles catalog/i,
    })
    expect(refreshButton).toBeDisabled()
    expect(refreshButton).toHaveAttribute('aria-busy', 'true')
  })

  it('copies the share URL when the mobile share button is tapped', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const fixture = onlineLutSourcesFixture()
    fixture.share = {
      enabled: true,
      url: '/raw?luts=https%3A%2F%2Fprofiles.example.com%2Fcatalog.json',
      copy,
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    await userEvent.click(
      screen.getByRole('button', { name: /copy lut source link/i }),
    )

    expect(copy).toHaveBeenCalledTimes(1)
  })

  it('disables the mobile share button when there is nothing to share', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.share = {
      enabled: false,
      url: '',
      copy: vi.fn().mockResolvedValue(undefined),
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByRole('button', { name: /copy lut source link/i }),
    ).toBeDisabled()
  })

  it('keeps current LUT and online source controls at mobile touch-target size', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.sourceUrlInput = 'https://profiles.example.com/extra.json'
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByRole('button', { name: /close lut browser/i }),
    ).toHaveClass('size-[44px]')
    expect(screen.getByRole('button', { name: /clear lut/i })).toHaveClass(
      'min-h-[44px]',
    )
    expect(
      screen.getByRole('button', { name: /copy lut source link/i }),
    ).toHaveClass('size-[44px]')
    expect(screen.getByLabelText(/online lut source url/i)).toHaveClass(
      'h-[44px]',
    )
    expect(screen.getByRole('button', { name: /add lut source/i })).toHaveClass(
      'size-[44px]',
    )
    expect(
      screen.getByRole('button', { name: /refresh profiles catalog/i }),
    ).toHaveClass('size-[44px]')
    expect(
      screen.getByRole('button', { name: /remove profiles catalog/i }),
    ).toHaveClass('size-[44px]')
  })

  it('keeps catalog entry rows at mobile touch-target size', async () => {
    const fixture = onlineLutSourcesFixture()
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    await userEvent.click(
      screen.getByRole('button', { name: /open profiles catalog/i }),
    )

    expect(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    ).toHaveClass('min-h-[52px]')
  })

  it('keeps mobile catalog browsing in the dark on-photo surface family', async () => {
    const fixture = onlineLutSourcesFixture()
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    const sourceCard = document.querySelector(
      '[data-raw-mobile-lut="source-card"]',
    )
    expect(sourceCard).toHaveClass('bg-transparent')
    expect(sourceCard).not.toHaveClass('bg-lf-surface-muted/55')

    const sourceInput = screen.getByLabelText(/online lut source url/i)
    expect(sourceInput).toHaveClass('focus:ring-lf-green/25')
    expect(sourceInput).not.toHaveClass('focus:border-lf-amber')

    await userEvent.click(
      screen.getByRole('button', { name: /open profiles catalog/i }),
    )

    const entry = screen.getByRole('button', {
      name: /load kodak 2383 rec.709/i,
    })
    expect(entry).toHaveClass('hover:bg-lf-on-photo-bg-strong')
    expect(entry).not.toHaveClass(
      'hover:bg-[oklch(from_var(--color-lf-on-surface)_l_c_h_/_0.045)]',
    )
    expect(entry).not.toHaveClass('border-lf-hairline/40')
  })

  it('hints at the expected manifest URL shape when no online sources exist', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      resources: [],
      entries: [],
      issues: [],
      activeResourceId: null,
      isLoading: false,
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByText(/paste a catalog\.json or lumaforge-profiles\.json/i),
    ).toBeInTheDocument()
  })

  it('surfaces a per-resource issue summary inside the resource card', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      ...fixture.state,
      issues: [
        {
          code: 'network',
          message:
            'Failed to fetch online profile resource: https://example.com/catalog.json',
          resourceId: 'source-1',
        },
      ],
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    // The raw runtime string (with its URL) is replaced by translated copy.
    expect(
      screen.getByText('This source could not be reached.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/https:\/\//)).not.toBeInTheDocument()
  })

  it('collapses multiple resource issues into one warning with a count', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      ...fixture.state,
      issues: [
        {
          code: 'unsupported-entry',
          message: 'Only LUT entries are supported.',
          resourceId: 'source-1',
          entryId: 'a',
        },
        {
          code: 'missing-sha256',
          message: 'Primary asset sha256 is missing.',
          resourceId: 'source-1',
          entryId: 'b',
        },
      ],
    }
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByText("Some entries aren't supported LUTs."),
    ).toBeInTheDocument()
    expect(screen.getByText('+1 more')).toBeInTheDocument()
  })
})
