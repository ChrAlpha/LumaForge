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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { MobileLookControls } from './MobileLookDeck'
import { MobileLookDeck } from './MobileLookDeck'

const SHA_KODAK = 'a'.repeat(64)
const SHA_PORTRA = 'b'.repeat(64)

function sourcesFixture(
  overrides: Partial<UseOnlineLutSourcesResult> = {},
): UseOnlineLutSourcesResult {
  const entry = (id: string, title: string, sha256: string) => ({
    id,
    resourceId: 'profiles',
    title,
    family: 'Print Film',
    sourceUrl: `https://profiles.example.com/${id}.json`,
    sourceType: 'catalog-entry' as const,
    cube: { url: `https://profiles.example.com/${id}.cube`, sha256 },
    tags: [],
  })
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
      entries: [
        entry('kodak', 'Kodak 2383', SHA_KODAK),
        entry('portra', 'Portra 400', SHA_PORTRA),
      ],
      issues: [],
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
    share: { enabled: false, url: '', copy: vi.fn() },
    ...overrides,
  }
}

function look(overrides: Partial<MobileLookControls> = {}): MobileLookControls {
  return {
    currentLutName: null,
    appliedLut: null,
    disabled: false,
    onLutLoad: vi.fn(),
    onLutClear: vi.fn(),
    lutProfileSelection: null,
    lutProfileResolution: null,
    onLutProfileSelect: vi.fn(),
    onlineLutSources: sourcesFixture(),
    activeIntensity: 'standard',
    onIntensitySelect: vi.fn(),
    ...overrides,
  }
}

const confirmedDisplayLook = {
  ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
  role: 'combined-look-output' as const,
  outputGamut: 'srgb-rec709' as const,
  outputTransfer: 'srgb' as const,
  outputRange: 'full' as const,
}

function renderDeck(
  controls: MobileLookControls = look(),
  handlers: {
    onOpenSources?: () => void
    onOpenContract?: () => void
  } = {},
) {
  return render(
    <MobileLookDeck
      look={controls}
      onOpenSources={handlers.onOpenSources ?? vi.fn()}
      onOpenContract={handlers.onOpenContract ?? vi.fn()}
    />,
  )
}

function tile(name: string | RegExp) {
  return within(screen.getByRole('group', { name: 'Looks' })).getByRole(
    'button',
    { name },
  )
}

describe('mobileLookDeck', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('lays the strip out as Original, the catalog, then Import', () => {
    const { container } = renderDeck()
    const tiles = Array.from(
      container.querySelectorAll<HTMLElement>('[data-mobile-lut-tile]'),
    ).map((node) => `${node.dataset.mobileLutTile}:${node.dataset.lutTitle}`)
    expect(tiles).toEqual([
      'original:Original',
      'entry:Kodak 2383',
      'entry:Portra 400',
      'import:Import .cube',
    ])
    // 72 x 60 tiles that snap, on a strip that scrolls on its own.
    expect(tile('Kodak 2383')).toHaveClass('h-[60px]', 'w-[72px]', 'snap-start')
    expect(screen.getByRole('group', { name: 'Looks' })).toHaveClass(
      'overflow-x-auto',
      '[scroll-snap-type:x_proximity]',
      '[scroll-padding-inline:12px]',
    )
    // With nothing applied the Original is the pressed tile.
    expect(tile('Original')).toHaveAttribute('aria-pressed', 'true')
    expect(tile('Original')).toHaveAttribute('data-state', 'applied')
    expect(tile('Kodak 2383')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('No LUT · tone and color only')).toBeVisible()
  })

  it('reads the applied look from the cube hash and rings its tile', () => {
    const { container } = renderDeck(
      look({
        currentLutName: 'Portra 400',
        appliedLut: { name: 'Portra 400', sha256: SHA_PORTRA },
        lutProfileResolution: {
          kind: 'confirmed',
          profile: confirmedDisplayLook,
          confidence: 'metadata',
        },
      }),
    )
    const portra = tile('Portra 400')
    expect(portra).toHaveAttribute('aria-pressed', 'true')
    expect(portra).toHaveAttribute('data-state', 'applied')
    expect(portra.querySelector('[data-applied-ring]')).toHaveClass(
      'opacity-100',
      'duration-150',
      'shadow-[inset_0_0_0_1.5px_oklch(0.96_0.006_255/0.92)]',
    )
    expect(portra.querySelector('[data-applied-check]')).not.toBeNull()
    expect(tile('Original')).toHaveAttribute('aria-pressed', 'false')
    // The catalog matched, so there is no file tile.
    expect(
      container.querySelector('[data-mobile-lut-tile="custom"]'),
    ).toBeNull()
  })

  it('shows a file that matches no entry as My file, flagged while its contract is open', () => {
    renderDeck(
      look({
        currentLutName: 'Client Look',
        appliedLut: {
          name: 'Client Look',
          sha256: 'c'.repeat(64),
          sourceName: 'client-look.cube',
        },
        lutProfileResolution: { kind: 'unknown' },
      }),
    )
    const file = tile('client-look.cube')
    expect(file).toHaveAttribute('aria-pressed', 'true')
    expect(file).toHaveAttribute('data-state', 'needs-contract')
    expect(file).toHaveTextContent('My file')
    // Amber marks the contract, and words carry it too.
    expect(file.querySelector('[data-needs-contract-dot]')).toHaveClass(
      'bg-lf-amber',
      'size-[7px]',
    )
    expect(file).toHaveTextContent('Needs its color contract')
  })

  it('loads a tapped look and keeps a tap on the applied one a no-op', async () => {
    const sources = sourcesFixture()
    renderDeck(
      look({
        currentLutName: 'Kodak 2383',
        appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
        onlineLutSources: sources,
      }),
    )
    await userEvent.click(tile('Kodak 2383'))
    expect(sources.loadEntry).not.toHaveBeenCalled()

    await userEvent.click(tile('Portra 400'))
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
  })

  it('cancels the look still loading and loads the newly tapped one', async () => {
    const sources = sourcesFixture({
      loadingEntryId: 'kodak',
      entryLoadProgress: {
        entryId: 'kodak',
        receivedBytes: 40,
        totalBytes: 100,
      },
    })
    renderDeck(look({ onlineLutSources: sources }))

    const loading = screen.getByRole('button', {
      name: 'Cancel download of Kodak 2383',
    })
    expect(loading).toHaveAttribute('data-state', 'loading')
    expect(loading).toHaveAttribute('aria-busy', 'true')
    const bar = loading.querySelector<HTMLElement>('[data-load-progress] span')!
    expect(bar.style.width).toBe('40%')

    await userEvent.click(tile('Portra 400'))
    expect(sources.cancelEntryLoad).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
    expect(sources.loadEntry).not.toHaveBeenCalledWith('kodak')
  })

  it('cancels a load when its own tile is tapped again', async () => {
    const sources = sourcesFixture({ loadingEntryId: 'kodak' })
    renderDeck(look({ onlineLutSources: sources }))
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel download of Kodak 2383' }),
    )
    expect(sources.cancelEntryLoad).toHaveBeenCalledOnce()
    expect(sources.loadEntry).not.toHaveBeenCalled()
  })

  it('names a failed load in the footer, neutral, and retries from it or the tile', async () => {
    const sources = sourcesFixture({ failedEntryId: 'portra' })
    const { container } = renderDeck(look({ onlineLutSources: sources }))

    const failed = screen.getByRole('button', {
      name: "Couldn't load Portra 400. Tap to retry.",
    })
    expect(failed).toHaveAttribute('data-state', 'failed')
    expect(failed).toHaveClass('opacity-60')
    expect(failed.querySelector('[data-failed-glyph]')).not.toBeNull()

    const footer = container.querySelector<HTMLElement>(
      '[data-look-footer="failure"]',
    )!
    expect(footer).toHaveTextContent("Couldn't load Portra 400.")
    // Not a contract and not destructive: no amber, no rose.
    expect(container.innerHTML).not.toMatch(/amber|rose/)

    await userEvent.click(within(footer).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )

    vi.mocked(sources.loadEntry).mockClear()
    await userEvent.click(failed)
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
  })

  it('clears the look from the Original tile and stops a look on its way', async () => {
    const sources = sourcesFixture()
    const controls = look({
      currentLutName: 'Kodak 2383',
      appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
      onlineLutSources: sources,
    })
    renderDeck(controls)
    await userEvent.click(tile('Original'))
    expect(sources.cancelEntryLoad).toHaveBeenCalledOnce()
    expect(controls.onLutClear).toHaveBeenCalledOnce()
  })

  it('imports a .cube from its tile through a hidden file input', async () => {
    const sources = sourcesFixture()
    const controls = look({ onlineLutSources: sources })
    const { container } = renderDeck(controls)
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".cube"]',
    )!
    expect(input).toHaveClass('hidden')
    const click = vi.spyOn(input, 'click')
    await userEvent.click(tile('Import .cube'))
    expect(click).toHaveBeenCalledOnce()

    const file = new File(['LUT_3D_SIZE 2'], 'mine.cube')
    fireEvent.change(input, { target: { files: [file] } })
    expect(controls.onLutLoad).toHaveBeenCalledWith([file])
    expect(sources.cancelEntryLoad).toHaveBeenCalled()
  })

  it('holds every tile while the pipeline is busy', () => {
    renderDeck(look({ disabled: true }))
    for (const name of ['Original', 'Kodak 2383', 'Import .cube']) {
      expect(tile(name)).toBeDisabled()
      expect(tile(name)).toHaveAttribute('data-state', 'disabled')
    }
  })

  it('keeps Strength off without a LUT and says why when it is pressed', () => {
    vi.useFakeTimers()
    const { container } = renderDeck()
    const strength = screen.getByRole('tablist', { name: 'Strength' })
    expect(within(strength).getByRole('tab', { name: 'Strong' })).toBeDisabled()
    expect(strength).toHaveAccessibleDescription(
      'Choose a LUT to set its strength',
    )

    fireEvent.pointerDown(
      container.querySelector('[data-strength-blocked-catcher]')!,
    )
    expect(
      container.querySelector('[data-look-footer="strength"]'),
    ).toHaveTextContent('Choose a LUT to set its strength')
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(
      container.querySelector('[data-look-footer="no-lut"]'),
    ).not.toBeNull()
  })

  it('sets the strength of an applied LUT on 44px segments', async () => {
    const controls = look({
      currentLutName: 'Kodak 2383',
      appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
      strengthDisabled: false,
    })
    renderDeck(controls)
    const strength = screen.getByRole('tablist', { name: 'Strength' })
    expect(strength).toHaveClass('h-11')
    await userEvent.click(within(strength).getByRole('tab', { name: 'Strong' }))
    expect(controls.onIntensitySelect).toHaveBeenCalledWith('strong')
  })

  it('offers a recommended contract as a one-tap Apply', async () => {
    const recommendation = confirmedDisplayLook
    const controls = look({
      currentLutName: 'SLog3 Look',
      appliedLut: { name: 'SLog3 Look', sha256: 'd'.repeat(64) },
      lutProfileResolution: {
        kind: 'recommended',
        recommendations: [recommendation],
      } as never,
    })
    const onOpenContract = vi.fn()
    renderDeck(controls, { onOpenContract })
    expect(
      screen.getByText(`Recommended: ${recommendation.label}`),
    ).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(controls.onLutProfileSelect).toHaveBeenCalledWith(recommendation)

    await userEvent.click(
      screen.getByRole('button', {
        name: `Recommended: ${recommendation.label}`,
      }),
    )
    expect(onOpenContract).toHaveBeenCalledWith('input')
  })

  it('opens the LUT sources from the footer on a 44px target', async () => {
    const onOpenSources = vi.fn()
    renderDeck(look(), { onOpenSources })
    const sources = screen.getByRole('button', { name: /lut sources/i })
    expect(sources).toHaveClass('min-h-11')
    await userEvent.click(sources)
    expect(onOpenSources).toHaveBeenCalledOnce()
  })
})
