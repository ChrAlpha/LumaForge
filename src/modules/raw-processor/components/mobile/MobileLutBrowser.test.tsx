import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import { MobileLutBrowser } from './MobileLutBrowser'

const baseProps = {
  open: true,
  onClose: vi.fn(),
  disabled: false,
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
    loadedEntry: null,
    activateCatalogs: vi.fn(),
    resourceActivation: { 'source-1': 'ready' },
    catalogActivation: 'ready',
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

  it('renders the LUT sources sheet and closes via the close button', async () => {
    const onClose = vi.fn()
    render(<MobileLutBrowser {...baseProps} onClose={onClose} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('data-mobile-substrate', 'ink-sheet')
    expect(dialog).toHaveAccessibleName('LUT sources')
    // Choosing and tuning the look lives in the Look deck now: no current
    // LUT card, no Strength, no contract editor in the sheet.
    expect(screen.queryByText('Current LUT')).toBeNull()
    expect(screen.queryByRole('tablist', { name: 'Strength' })).toBeNull()
    expect(screen.queryByLabelText('Search LUT contract')).toBeNull()

    await userEvent.click(
      screen.getByRole('button', { name: /close lut sources/i }),
    )

    expect(onClose).toHaveBeenCalled()
  })

  it('opens a big source in full, loads a look from it, and closes so the photo shows it', async () => {
    const onClose = vi.fn()
    const loadEntry = vi.fn().mockResolvedValue('loaded' as const)
    render(
      <MobileLutBrowser
        {...baseProps}
        onClose={onClose}
        onlineLutSources={withManyOnlineEntries(
          onlineLutSourcesFixture(loadEntry),
        )}
      />,
    )

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-mobile-lut-view',
      'overview',
    )
    // The looks themselves are on the strip; the sheet lists none inline.
    expect(screen.queryByRole('button', { name: /^load /i })).toBeNull()

    const all = screen.getByRole('button', {
      name: 'All 5 LUTs from Profiles catalog',
    })
    expect(all).toHaveTextContent('All 5 LUTs')
    expect(all).toHaveClass('min-h-11')
    await userEvent.click(all)

    expect(screen.getByRole('dialog')).toHaveAttribute(
      'data-mobile-lut-view',
      'catalog',
    )

    await userEvent.click(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    )
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709')
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('offers no full catalog for a source with a single look', () => {
    render(
      <MobileLutBrowser
        {...baseProps}
        onlineLutSources={onlineLutSourcesFixture()}
      />,
    )
    expect(screen.queryByRole('button', { name: /^all /i })).toBeNull()
    expect(screen.getByText('1 LUT')).toBeInTheDocument()
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
          onlineLutSources={withManyOnlineEntries(
            onlineLutSourcesFixture(loadEntry),
          )}
        />,
      )

      await userEvent.click(
        screen.getByRole('button', {
          name: /all 5 luts from profiles catalog/i,
        }),
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
    fixture.resourceActivation = { 'source-1': 'loading' }
    fixture.catalogActivation = 'loading'
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

  it('keeps the source controls at mobile touch-target size', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.sourceUrlInput = 'https://profiles.example.com/extra.json'
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    expect(
      screen.getByRole('button', { name: /close lut sources/i }),
    ).toHaveClass('size-[44px]')
    expect(
      screen.getByRole('button', { name: /copy lut source link/i }),
    ).toHaveClass('size-[44px]')
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
    const fixture = withManyOnlineEntries(onlineLutSourcesFixture())
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    await userEvent.click(
      screen.getByRole('button', { name: /all 5 luts from profiles catalog/i }),
    )

    expect(
      screen.getByRole('button', { name: /load kodak 2383 rec.709/i }),
    ).toHaveClass('min-h-[52px]')
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
    const warning = screen.getByText('This source could not be reached.')
    expect(warning).toBeInTheDocument()
    expect(screen.queryByText(/https:\/\//)).not.toBeInTheDocument()
  })

  it('names a failed catalog download with Retry', async () => {
    const fixture = withManyOnlineEntries(onlineLutSourcesFixture())
    fixture.failedEntryId = 'kodak-2383-rec709'
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)
    await userEvent.click(
      screen.getByRole('button', { name: /all 5 luts from profiles catalog/i }),
    )
    const failed = screen.getByRole('button', {
      name: "Couldn't load Kodak 2383 Rec.709. Tap to retry.",
    })
    expect(failed).toHaveTextContent('Retry')
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

  it('activates the catalogs only while the sheet is open', () => {
    const fixture = onlineLutSourcesFixture()
    const { rerender } = render(
      <MobileLutBrowser
        {...baseProps}
        open={false}
        onlineLutSources={fixture}
      />,
    )
    // Mounted closed is not a visit.
    expect(fixture.activateCatalogs).not.toHaveBeenCalled()

    rerender(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)
    expect(fixture.activateCatalogs).toHaveBeenCalledOnce()
    expect(fixture.activateCatalogs).toHaveBeenCalledWith()

    // A re-render while open asks nothing more.
    rerender(
      <MobileLutBrowser
        {...baseProps}
        onlineLutSources={{ ...fixture, sourceUrlInput: 'https://' }}
      />,
    )
    expect(fixture.activateCatalogs).toHaveBeenCalledOnce()

    rerender(
      <MobileLutBrowser
        {...baseProps}
        open={false}
        onlineLutSources={fixture}
      />,
    )
    expect(fixture.activateCatalogs).toHaveBeenCalledOnce()

    // Reopening asks again; activation itself skips a loaded catalog.
    rerender(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)
    expect(fixture.activateCatalogs).toHaveBeenCalledTimes(2)
  })

  it('states a source that has not loaded and one that is loading', () => {
    const fixture = onlineLutSourcesFixture()
    fixture.state = {
      ...fixture.state,
      resources: [
        ...fixture.state.resources,
        {
          id: 'source-2',
          url: 'https://looks.example.com/catalog.json',
          type: 'catalog',
          label: 'Looks catalog',
          fromQuery: false,
        },
      ],
      entries: [],
    }
    fixture.resourceActivation = { 'source-1': 'loading' }
    fixture.catalogActivation = 'loading'
    render(<MobileLutBrowser {...baseProps} onlineLutSources={fixture} />)

    const card = (label: string) =>
      screen
        .getByText(label)
        .closest<HTMLElement>('[data-raw-mobile-lut="source-card"]')!
    expect(within(card('Profiles catalog')).getByText('Loading')).toBeVisible()
    expect(
      within(card('Profiles catalog')).getByRole('button', {
        name: 'Refresh Profiles catalog',
      }),
    ).toBeDisabled()
    expect(within(card('Looks catalog')).getByText('Not loaded')).toBeVisible()
    expect(within(card('Looks catalog')).queryByText('No LUTs')).toBeNull()
  })
})
