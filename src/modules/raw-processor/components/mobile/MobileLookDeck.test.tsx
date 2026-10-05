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
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UseOnlineLutSourcesResult } from '../../hooks/useOnlineLutSources'
import type { MobileLookView } from './mobile-stage-layout'
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
    loadedEntry: null,
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
    activeIntensity: 0.7,
    onIntensityChange: vi.fn(),
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

function DeckHarness(props: {
  controls: MobileLookControls
  onOpenSources?: () => void
  onViewChange?: (view: MobileLookView) => void
  initialView?: MobileLookView
}) {
  const [view, setView] = useState<MobileLookView>(props.initialView ?? 'strip')
  return (
    <MobileLookDeck
      look={props.controls}
      onOpenSources={props.onOpenSources ?? vi.fn()}
      view={view}
      onViewChange={(next) => {
        props.onViewChange?.(next)
        setView(next)
      }}
    />
  )
}

function renderDeck(
  controls: MobileLookControls = look(),
  handlers: {
    onOpenSources?: () => void
    onViewChange?: (view: MobileLookView) => void
    initialView?: MobileLookView
  } = {},
) {
  const utils = render(<DeckHarness controls={controls} {...handlers} />)
  return {
    ...utils,
    rerenderDeck: (next: MobileLookControls) =>
      utils.rerender(<DeckHarness controls={next} {...handlers} />),
  }
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
    // The Strength slider (Radix) measures its thumb.
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
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps the deck to one shrinkable column so the strip cannot widen it', () => {
    const { container } = renderDeck()
    // The strip scroller is as wide as every tile; an auto grid column grows
    // to that width and pushes Strength and the footer off the screen.
    expect(
      container.querySelector('[data-mobile-look-deck="strip"]'),
    ).toHaveClass('grid-cols-[minmax(0,1fr)]')
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
    expect(screen.getByText('No LUT · tone and color only')).toBeInTheDocument()
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

  it('marks a hashless direct .cube look applied from the load the sources recorded', () => {
    // A direct .cube URL declares no hash. The pairing of its load with the
    // applied hash lives with the LUT sources, so a freshly mounted deck
    // (or a load made from the LUT sources sheet) still rings its tile.
    const direct = {
      id: 'direct',
      resourceId: 'profiles',
      title: 'direct.cube',
      sourceUrl: 'https://example.com/direct.cube',
      sourceType: 'direct-cube' as const,
      cube: { url: 'https://example.com/direct.cube', sha256: '' },
      tags: [],
    }
    const base = sourcesFixture()
    const sources = sourcesFixture({
      state: { ...base.state, entries: [...base.state.entries, direct] },
      loadedEntry: { entryId: 'direct', sha256: 'd'.repeat(64) },
    })
    const { container } = renderDeck(
      look({
        currentLutName: 'Direct',
        appliedLut: { name: 'Direct', sha256: 'd'.repeat(64) },
        onlineLutSources: sources,
      }),
    )
    expect(tile('direct.cube')).toHaveAttribute('aria-pressed', 'true')
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
    // My file names the tile's group, the way a family names its looks.
    expect(
      within(screen.getByRole('group', { name: 'My file' })).getByRole(
        'button',
      ),
    ).toBe(file)
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

  it('stops a look tapped this frame when Original is tapped before it starts', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const sources = sourcesFixture()
    renderDeck(look({ onlineLutSources: sources }))
    fireEvent.click(tile('Kodak 2383'))
    fireEvent.click(tile('Original'))
    await act(async () => {
      for (const frame of frames.splice(0)) frame(0)
    })
    expect(sources.loadEntry).not.toHaveBeenCalled()
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
    const strength = screen.getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('data-disabled')
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

  it('sets a continuous strength on a slider with Light, Standard and Strong detents', () => {
    const controls = look({
      currentLutName: 'Kodak 2383',
      appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
      activeIntensity: 0.62,
      strengthDisabled: false,
    })
    const { container } = renderDeck(controls)
    const strength = screen.getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('aria-valuenow', '62')
    expect(strength).toHaveAttribute('aria-valuetext', '62%')

    // The presets are ticks on the track with their names under it.
    const row = container.querySelector<HTMLElement>(
      '[data-mobile-look-strength]',
    )!
    expect(
      Array.from(row.querySelectorAll('[data-slider-tick]')).map((tick) =>
        tick.getAttribute('data-slider-tick'),
      ),
    ).toEqual(['40', '70', '100'])
    const labels = row.querySelector('[data-slider-tick-labels]')!
    expect(labels).toHaveTextContent('LightStandardStrong')
    expect(labels).toHaveClass('text-[0.6rem]', 'text-lf-on-photo-ink/52')

    // Arrows step 1%, Shift+arrows 10%.
    fireEvent.keyDown(strength, { key: 'ArrowRight' })
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.63)
    fireEvent.keyDown(strength, { key: 'ArrowLeft', shiftKey: true })
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.52)

    // Away from Standard the value is amber and is the reset.
    const reset = screen.getByRole('button', { name: 'Reset Strength' })
    expect(reset).toHaveTextContent('62%')
    expect(reset).toHaveClass('text-lf-amber-soft', 'tabular-nums')
    fireEvent.click(reset)
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.7)
  })

  it('reads Standard as the rest value and 0 as Off', () => {
    const applied = {
      currentLutName: 'Kodak 2383',
      appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
      strengthDisabled: false,
    }
    const { rerenderDeck } = renderDeck(
      look({ ...applied, activeIntensity: 0.7 }),
    )
    const reset = screen.getByRole('button', { name: 'Reset Strength' })
    expect(reset).toHaveTextContent('70%')
    expect(reset).toBeDisabled()
    expect(reset.className).not.toMatch(/amber/)

    rerenderDeck(look({ ...applied, activeIntensity: 0 }))
    expect(screen.getByRole('slider', { name: 'Strength' })).toHaveAttribute(
      'aria-valuetext',
      'Off',
    )
    expect(reset).toHaveTextContent('Off')
  })

  it('takes the Adjust focus while Strength scrubs: the HUD channel, the strip and footer dimmed', () => {
    // jsdom has no PointerEvent: without one the press carries no pointer
    // type or coordinates.
    class PointerEventPolyfill extends MouseEvent {
      pointerType: string
      pointerId: number
      isPrimary: boolean
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerType = init.pointerType ?? ''
        this.pointerId = init.pointerId ?? 0
        this.isPrimary = init.isPrimary ?? true
      }
    }
    vi.stubGlobal('PointerEvent', PointerEventPolyfill)
    const onScrubChange = vi.fn()
    const controls = look({
      currentLutName: 'Kodak 2383',
      appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
      strengthDisabled: false,
    })
    const { container } = render(
      <MobileLookDeck
        look={controls}
        onOpenSources={vi.fn()}
        view="strip"
        onViewChange={vi.fn()}
        onScrubChange={onScrubChange}
      />,
    )
    const row = container.querySelector<HTMLElement>(
      '[data-mobile-look-strength] [data-adjust-slider-row]',
    )!
    const pointer = {
      pointerType: 'mouse',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: 120,
      clientY: 20,
    }
    fireEvent.pointerDown(row, pointer)
    expect(onScrubChange).toHaveBeenLastCalledWith({ kind: 'strength' })
    expect(row).toHaveAttribute('data-active-scrub', 'true')
    const dimmed = container.querySelectorAll('[data-sibling-scrubbing]')
    expect(dimmed).toHaveLength(2)
    for (const node of dimmed) {
      expect(node).toHaveClass('pointer-events-none', 'opacity-45')
    }
    expect(dimmed[0]).toContainElement(
      screen.getByRole('group', { name: 'Looks' }),
    )
    expect(dimmed[1]).toContainElement(
      container.querySelector('[data-mobile-look-footer]') as HTMLElement,
    )

    fireEvent.pointerUp(row, pointer)
    expect(onScrubChange).toHaveBeenLastCalledWith(null)
    expect(container.querySelector('[data-sibling-scrubbing]')).toBeNull()
  })

  it('sits compact in the deck, about the touch target the segmented control was', () => {
    const { container } = renderDeck(
      look({
        currentLutName: 'Kodak 2383',
        appliedLut: { name: 'Kodak 2383', sha256: SHA_KODAK },
        strengthDisabled: false,
      }),
    )
    const row = container.querySelector<HTMLElement>(
      '[data-mobile-look-strength] [data-adjust-slider-row]',
    )!
    // No list padding: a 16px label line, a 21px track and a 10px name
    // line, against the 44px segmented control it replaced.
    expect(row).not.toHaveClass('py-1.5')
    expect(row).not.toHaveClass('px-3')
    expect(row.firstElementChild).toHaveClass('min-h-4')
    expect(
      row.querySelector('[data-testid="adjust-slider-row-scrub"]'),
    ).toHaveClass('py-2')
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
    const onViewChange = vi.fn()
    renderDeck(controls, { onViewChange })
    expect(
      screen.getByText(`Recommended: ${recommendation.label}`),
    ).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(controls.onLutProfileSelect).toHaveBeenCalledWith(recommendation)

    await userEvent.click(
      screen.getByRole('button', {
        name: `Recommended: ${recommendation.label}`,
      }),
    )
    expect(onViewChange).toHaveBeenLastCalledWith('contract')
    expect(
      screen.getByRole('region', { name: 'SLog3 Look: input' }),
    ).toBeInTheDocument()
  })

  it('opens the LUT sources from the footer on a 44px target', async () => {
    const onOpenSources = vi.fn()
    renderDeck(look(), { onOpenSources })
    const sources = screen.getByRole('button', { name: /lut sources/i })
    expect(sources).toHaveClass('min-h-11')
    await userEvent.click(sources)
    expect(onOpenSources).toHaveBeenCalledOnce()
  })

  describe('inline contract view', () => {
    const unknownFile = () =>
      look({
        currentLutName: 'Client Look',
        appliedLut: {
          name: 'Client Look',
          sha256: 'c'.repeat(64),
          sourceName: 'client.cube',
        },
        lutProfileSelection: {
          status: 'unknown',
          fingerprint: 'fp',
          title: 'Client Look',
        },
        lutProfileResolution: { kind: 'unknown' },
      })

    it('chooses input then output inside the deck and returns to the strip', async () => {
      const controls = unknownFile()
      const onViewChange = vi.fn()
      renderDeck(controls, { onViewChange })

      await userEvent.click(
        screen.getByRole('button', { name: /choose what this lut expects/i }),
      )
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
      const input = screen.getByRole('region', { name: 'client.cube: input' })
      expect(input).toHaveTextContent('1 / 2')
      // No sheet: the contract lives in the deck, touch-first.
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByLabelText('Search LUT contract')).toHaveClass(
        'min-h-[44px]',
      )
      expect(screen.getByRole('button', { name: 'Back to looks' })).toHaveClass(
        'size-11',
      )

      await userEvent.type(
        screen.getByLabelText('Search LUT contract'),
        'panasonic',
      )
      const panasonic = screen.getByRole('button', {
        name: 'Use Panasonic V-Gamut / V-Log as LUT input',
      })
      expect(panasonic).toHaveClass('min-h-[44px]')
      await userEvent.click(panasonic)

      const output = screen.getByRole('region', { name: 'client.cube: output' })
      expect(output).toHaveTextContent('2 / 2')
      expect(output).toHaveTextContent('Input: Panasonic V-Gamut / V-Log')
      // Back from the output goes to the input, not out of the editor.
      await userEvent.click(
        screen.getByRole('button', { name: 'Back to input' }),
      )
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toBeInTheDocument()
      await userEvent.click(
        screen.getByRole('button', {
          name: 'Use Panasonic V-Gamut / V-Log as LUT input',
        }),
      )

      await userEvent.type(
        screen.getByLabelText('Search LUT contract'),
        'display srgb',
      )
      await userEvent.click(
        screen.getByRole('button', { name: 'Use Display sRGB as LUT output' }),
      )
      expect(controls.onLutProfileSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          inputGamut: 'v-gamut',
          inputTransfer: 'v-log',
          outputGamut: 'srgb-rec709',
          outputTransfer: 'srgb',
          outputRange: 'full',
        }),
      )
      expect(onViewChange).toHaveBeenLastCalledWith('strip')
      expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
    })

    it('titles the contract by the catalog title of the applied look', () => {
      renderDeck(
        look({
          currentLutName: '2383 cube title',
          appliedLut: {
            name: '2383 cube title',
            sha256: SHA_KODAK,
            sourceName: '2383 manifest title',
          },
          lutProfileResolution: { kind: 'unknown' },
        }),
        { initialView: 'contract' },
      )
      expect(
        screen.getByRole('region', { name: 'Kodak 2383: input' }),
      ).toBeInTheDocument()
    })

    it('leads with recommendations: one tap applies a complete one', async () => {
      const complete = confirmedDisplayLook
      const controls = look({
        currentLutName: 'SLog3 Look',
        appliedLut: { name: 'SLog3 Look', sha256: 'd'.repeat(64) },
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [complete],
        } as never,
      })
      const onViewChange = vi.fn()
      renderDeck(controls, { onViewChange, initialView: 'contract' })

      const chips = screen.getByRole('group', { name: 'Recommended input' })
      await userEvent.click(within(chips).getByRole('button'))
      expect(controls.onLutProfileSelect).toHaveBeenCalledWith(complete)
      expect(onViewChange).toHaveBeenLastCalledWith('strip')
    })

    it('drafts an input-only recommendation and moves on to the output', async () => {
      const inputOnly = getLUTColorProfile('panasonic-vgamut-vlog')!
      const controls = look({
        currentLutName: 'VLog Look',
        appliedLut: { name: 'VLog Look', sha256: 'e'.repeat(64) },
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [inputOnly],
        } as never,
      })
      renderDeck(controls, { initialView: 'contract' })

      await userEvent.click(
        screen.getByRole('button', {
          name: 'Use Panasonic V-Gamut / V-Log as LUT input',
        }),
      )
      expect(controls.onLutProfileSelect).not.toHaveBeenCalled()
      expect(
        screen.getByRole('region', { name: 'VLog Look: output' }),
      ).toHaveTextContent('Input: Panasonic V-Gamut / V-Log')
    })

    it('starts at the output when only the output is missing, and marks a resolved output', async () => {
      const inputOnly = getLUTColorProfile('panasonic-vgamut-vlog')!
      renderDeck(
        look({
          currentLutName: 'VLog Look',
          appliedLut: { name: 'VLog Look', sha256: 'e'.repeat(64) },
          lutProfileResolution: {
            kind: 'confirmed',
            profile: inputOnly,
            confidence: 'user',
          },
        }),
        { initialView: 'contract' },
      )
      expect(
        screen.getByRole('region', { name: 'VLog Look: output' }),
      ).toBeInTheDocument()
    })

    it('marks the resolved output as active when changing a confirmed contract', async () => {
      renderDeck(
        look({
          currentLutName: 'SLog3 Look',
          appliedLut: { name: 'SLog3 Look', sha256: 'f'.repeat(64) },
          lutProfileResolution: {
            kind: 'confirmed',
            profile: confirmedDisplayLook,
            confidence: 'metadata',
          },
        }),
      )
      await userEvent.click(
        screen.getByRole('button', {
          name: /edit color contract for sony s-gamut3\.cine \/ s-log3/i,
        }),
      )
      await userEvent.click(
        screen.getByRole('button', {
          name: 'Use Sony S-Gamut3.Cine / S-Log3 as LUT input',
        }),
      )
      expect(
        screen.getByRole('button', {
          name: 'Use Rec.709 display as LUT output',
        }),
      ).toHaveAttribute('aria-pressed', 'true')
    })

    it('opens the contract by itself after an import that nothing resolved', async () => {
      const controls = look()
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(controls, {
        onViewChange,
      })
      const input = container.querySelector<HTMLInputElement>(
        'input[type="file"][accept=".cube"]',
      )!
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'client.cube')] },
      })
      expect(onViewChange).not.toHaveBeenCalled()

      // The session reports the imported LUT, its contract unknown.
      rerenderDeck(unknownFile())
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toBeInTheDocument()
    })

    it("does not open a later look's contract after an import that failed", async () => {
      let settle!: (outcome: string) => void
      const onLutLoad = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            settle = resolve
          }),
      )
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(look({ onLutLoad }), {
        onViewChange,
      })
      fireEvent.change(
        container.querySelector<HTMLInputElement>('input[type="file"]')!,
        { target: { files: [new File(['x'], 'broken.cube')] } },
      )
      expect(onLutLoad).toHaveBeenCalledOnce()
      // The parse fails: nothing new is applied.
      await act(async () => settle('failed'))

      // Much later, a look from elsewhere lands without a contract.
      rerenderDeck(unknownFile())
      expect(onViewChange).not.toHaveBeenCalledWith('contract')
    })

    it('still opens the contract when the imported LUT lands before the import settles', async () => {
      let settle!: (outcome: string) => void
      const onLutLoad = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            settle = resolve
          }),
      )
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(look({ onLutLoad }), {
        onViewChange,
      })
      fireEvent.change(
        container.querySelector<HTMLInputElement>('input[type="file"]')!,
        { target: { files: [new File(['x'], 'client.cube')] } },
      )
      rerenderDeck({ ...unknownFile(), onLutLoad })
      await act(async () => settle('loaded'))
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
    })

    it('disarms an import that never reported back once a strip tile is tapped', async () => {
      const onViewChange = vi.fn()
      const controls = look()
      const { container, rerenderDeck } = renderDeck(controls, {
        onViewChange,
      })
      fireEvent.change(
        container.querySelector<HTMLInputElement>('input[type="file"]')!,
        { target: { files: [new File(['x'], 'client.cube')] } },
      )
      await userEvent.click(tile('Kodak 2383'))
      rerenderDeck(unknownFile())
      expect(onViewChange).not.toHaveBeenCalledWith('contract')
    })

    it('leaves the strip alone after an import whose contract resolved', () => {
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(look(), { onViewChange })
      fireEvent.change(
        container.querySelector<HTMLInputElement>('input[type="file"]')!,
        { target: { files: [new File(['x'], 'display.cube')] } },
      )
      rerenderDeck(
        look({
          currentLutName: 'Display',
          appliedLut: { name: 'Display', sha256: '1'.repeat(64) },
          lutProfileResolution: {
            kind: 'confirmed',
            profile: confirmedDisplayLook,
            confidence: 'metadata',
          },
        }),
      )
      expect(onViewChange).not.toHaveBeenCalled()
    })

    it('falls back to the strip when the LUT goes away', () => {
      const onViewChange = vi.fn()
      const { rerenderDeck } = renderDeck(unknownFile(), {
        onViewChange,
        initialView: 'contract',
      })
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toBeInTheDocument()
      rerenderDeck(look())
      expect(onViewChange).toHaveBeenLastCalledWith('strip')
      expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
    })
  })
})
