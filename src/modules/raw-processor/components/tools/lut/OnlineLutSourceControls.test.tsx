import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../../hooks/useOnlineLutSources'
import type { OnlineLUTSourceActivation } from '../../../services/look/online-lut-sources'
import { OnlineLutSourceControls } from './OnlineLutSourceControls'

type Entry = UseOnlineLutSourcesResult['state']['entries'][number]

const entry = (id: string, title: string): Entry => ({
  id,
  resourceId: 'profiles',
  title,
  sourceUrl: `https://profiles.example.com/${id}.json`,
  sourceType: 'catalog-entry',
  cube: {
    url: `https://profiles.example.com/${id}.cube`,
    sha256: 'a'.repeat(64),
  },
  tags: [],
})

function sourcesFixture(
  overrides: {
    activation?: OnlineLUTSourceActivation
    entries?: Entry[]
    issues?: UseOnlineLutSourcesResult['state']['issues']
  } = {},
): UseOnlineLutSourcesResult {
  const activation = overrides.activation ?? 'inactive'
  return {
    state: {
      resources: [
        {
          id: 'profiles',
          url: 'https://profiles.example.com/catalog.json',
          type: 'catalog',
          label: 'LumaForge Profiles',
          fromQuery: false,
        },
      ],
      entries: overrides.entries ?? [],
      issues: overrides.issues ?? [],
      activeResourceId: null,
      isLoading: false,
    },
    sourceUrlInput: '',
    setSourceUrlInput: vi.fn(),
    addSourceFromInput: vi.fn(),
    refreshSource: vi.fn(),
    removeSource: vi.fn(),
    loadEntry: vi.fn(async () => 'loaded' as const),
    loadingEntryId: null,
    failedEntryId: null,
    entryLoadProgress: null,
    cancelEntryLoad: vi.fn(),
    loadedEntry: null,
    activateCatalogs: vi.fn(),
    resourceActivation:
      activation === 'inactive' ? {} : { profiles: activation },
    catalogActivation: activation,
    share: { enabled: false, url: '', copy: vi.fn() },
  }
}

function sourceRow() {
  return screen
    .getByText('LumaForge Profiles')
    .closest<HTMLElement>('[data-raw-lut="source-resource"]')!
}

describe('onlineLutSourceControls catalog activation', () => {
  it('lists a default source before its catalog is requested', () => {
    const sources = sourcesFixture()
    render(<OnlineLutSourceControls onlineLutSources={sources} />)

    // The Look card mounting is not a request for the catalog.
    expect(sources.activateCatalogs).not.toHaveBeenCalled()
    const row = sourceRow()
    expect(
      within(row).getByText('Not loaded', {
        selector: '[data-raw-lut="source-count-chip"]',
      }),
    ).toBeInTheDocument()
    expect(within(row).queryByText('No LUTs')).toBeNull()
  })

  it('loads an inactive source from its row, without loaded rows', () => {
    const sources = sourcesFixture()
    render(<OnlineLutSourceControls onlineLutSources={sources} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Load LUTs from LumaForge Profiles' }),
    )
    expect(sources.activateCatalogs).toHaveBeenCalledOnce()
    expect(sources.activateCatalogs).toHaveBeenCalledWith({
      resourceIds: ['profiles'],
    })
  })

  it('opening an inactive source requests its catalog and opens the browser', () => {
    const sources = sourcesFixture()
    render(<OnlineLutSourceControls onlineLutSources={sources} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Open LumaForge Profiles' }),
    )
    expect(sources.activateCatalogs).toHaveBeenCalledWith({
      resourceIds: ['profiles'],
    })
    expect(
      screen.getByRole('dialog', { name: 'LumaForge Profiles LUTs' }),
    ).toBeInTheDocument()
  })

  it('reads a source as loading from its own activation', () => {
    const sources = sourcesFixture({ activation: 'loading' })
    const { container } = render(
      <OnlineLutSourceControls onlineLutSources={sources} />,
    )

    const row = sourceRow()
    expect(within(row).getByText('Loading')).toBeInTheDocument()
    expect(
      container.querySelectorAll('[data-raw-lut="entry-skeleton"]'),
    ).toHaveLength(4)
    expect(
      within(row).queryByRole('button', { name: /^load luts/i }),
    ).toBeNull()
    expect(
      within(row).getByRole('button', { name: 'Refresh LumaForge Profiles' }),
    ).toHaveAttribute('aria-busy', 'true')
  })

  it('offers an explicit retry once the catalog failed', () => {
    const sources = sourcesFixture({
      activation: 'error',
      issues: [{ code: 'network', message: 'offline', resourceId: 'profiles' }],
    })
    render(<OnlineLutSourceControls onlineLutSources={sources} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Retry LumaForge Profiles' }),
    )
    expect(sources.activateCatalogs).toHaveBeenCalledWith({
      resourceIds: ['profiles'],
      retryFailed: true,
    })
    expect(
      screen.getByText('This source could not be reached.'),
    ).toBeInTheDocument()
  })

  it('shows the catalog once it is ready', () => {
    const sources = sourcesFixture()
    const { rerender } = render(
      <OnlineLutSourceControls onlineLutSources={sources} />,
    )
    rerender(
      <OnlineLutSourceControls
        onlineLutSources={sourcesFixture({
          activation: 'ready',
          entries: [entry('kodak', 'Kodak 2383')],
        })}
      />,
    )

    const row = sourceRow()
    expect(within(row).getByText('1 LUT')).toBeInTheDocument()
    expect(
      within(row).getByRole('button', { name: /kodak 2383/i }),
    ).toBeInTheDocument()
    expect(
      within(row).queryByRole('button', { name: /^load luts/i }),
    ).toBeNull()
    expect(within(row).queryByRole('button', { name: /^retry/i })).toBeNull()
  })

  it('keeps Add, Refresh, Remove and Share wired as before', () => {
    const sources = sourcesFixture({
      activation: 'ready',
      entries: [entry('kodak', 'Kodak 2383')],
    })
    render(<OnlineLutSourceControls onlineLutSources={sources} />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh LumaForge Profiles' }),
    )
    expect(sources.refreshSource).toHaveBeenCalledWith('profiles')
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove LumaForge Profiles' }),
    )
    expect(sources.removeSource).toHaveBeenCalledWith('profiles')
    expect(
      screen.getByRole('button', { name: 'Add LUT source' }),
    ).toBeDisabled()
    expect(
      screen.getByRole('button', { name: 'Copy LUT source link' }),
    ).toBeDisabled()
    expect(sources.activateCatalogs).not.toHaveBeenCalled()
  })
})
