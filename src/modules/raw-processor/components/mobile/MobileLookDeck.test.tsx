import type {
  LUTColorProfile,
  LUTContractResolution,
} from '@lumaforge/luma-color-runtime'
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
import { seedRawToolStore } from '../raw-tool-surface.fixture'
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
    activateCatalogs: vi.fn(),
    resourceActivation: { profiles: 'ready' },
    catalogActivation: 'ready',
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
    onIntensityChange: vi.fn(),
    ...overrides,
  }
}

/** A look applied under `name`, its cube hashed `sha256`. */
function applied(
  name: string,
  sha256: string,
  resolution: LUTContractResolution | null = null,
  overrides: Partial<MobileLookControls> = {},
) {
  return look({
    currentLutName: name,
    appliedLut: { name, sha256 },
    lutProfileResolution: resolution,
    ...overrides,
  })
}

const confirmedDisplayLook = {
  ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
  role: 'combined-look-output' as const,
  outputGamut: 'srgb-rec709' as const,
  outputTransfer: 'srgb' as const,
  outputRange: 'full' as const,
}
const confirmed = (
  profile: LUTColorProfile = confirmedDisplayLook,
): LUTContractResolution => ({
  kind: 'confirmed',
  profile,
  confidence: 'user',
})
const recommended = (
  profile: ReturnType<typeof getLUTColorProfile>,
): LUTContractResolution =>
  ({ kind: 'recommended', recommendations: [profile] }) as never

interface Handlers {
  onOpenSources?: () => void
  onViewChange?: (view: MobileLookView) => void
  initialView?: MobileLookView
}

/** The deck under a parent that owns its view, as the chrome does. */
function DeckHarness(props: Handlers & { controls: MobileLookControls }) {
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
  handlers: Handlers = {},
) {
  const utils = render(<DeckHarness controls={controls} {...handlers} />)
  return {
    ...utils,
    rerenderDeck: (next: MobileLookControls) =>
      utils.rerender(<DeckHarness controls={next} {...handlers} />),
  }
}

const tile = (name: string | RegExp) =>
  within(screen.getByRole('group', { name: 'Looks' })).getByRole('button', {
    name,
  })
const strength = () => screen.getByRole('slider', { name: 'Strength' })
const importCube = (container: HTMLElement, name: string) => {
  const file = new File(['LUT_3D_SIZE 2'], name)
  fireEvent.change(
    container.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".cube"]',
    )!,
    { target: { files: [file] } },
  )
  return file
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

  it('shows the Original applied without a LUT, and leaves catalog activation to the chrome', async () => {
    const sources = sourcesFixture()
    const onOpenSources = vi.fn()
    renderDeck(look({ onlineLutSources: sources }), { onOpenSources })
    expect(tile('Original')).toHaveAttribute('aria-pressed', 'true')
    expect(tile('Kodak 2383')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('No LUT · tone and color only')).toBeInTheDocument()
    // Mounting the deck is not seeing it: it may be leaving, or collapsed.
    expect(sources.activateCatalogs).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /lut sources/i }))
    expect(onOpenSources).toHaveBeenCalledOnce()
  })

  it.each([
    {
      look: 'a catalog look, by its cube hash',
      controls: () => applied('Portra 400', SHA_PORTRA),
      tile: 'Portra 400',
    },
    {
      // A direct .cube URL declares no hash: the LUT sources record which
      // load produced the applied hash, for every surface and remount.
      look: 'a hashless direct .cube, by the load the sources recorded',
      controls: () => {
        const sources = sourcesFixture()
        sources.state.entries.push({
          id: 'direct',
          resourceId: 'profiles',
          title: 'direct.cube',
          sourceUrl: 'https://example.com/direct.cube',
          sourceType: 'direct-cube',
          cube: { url: 'https://example.com/direct.cube', sha256: '' },
          tags: [],
        })
        sources.loadedEntry = { entryId: 'direct', sha256: 'd'.repeat(64) }
        return applied('Direct', 'd'.repeat(64), null, {
          onlineLutSources: sources,
        })
      },
      tile: 'direct.cube',
    },
    {
      look: 'a file that matches no entry, by its file name',
      controls: () =>
        look({
          currentLutName: 'Client Look',
          appliedLut: {
            name: 'Client Look',
            sha256: 'c'.repeat(64),
            sourceName: 'client-look.cube',
          },
        }),
      tile: 'client-look.cube',
    },
  ])('rings the tile of $look', ({ controls, tile: name }) => {
    renderDeck(controls())
    expect(tile(name)).toHaveAttribute('aria-pressed', 'true')
    expect(tile('Original')).toHaveAttribute('aria-pressed', 'false')
  })

  it.each([
    {
      contract: 'still open',
      resolution: { kind: 'unknown' },
      reason: null,
      flagged: true,
    },
    {
      contract: 'confirmed but left out of the preview',
      resolution: confirmed(),
      reason: 'lut-output-transfer-linear',
      flagged: true,
    },
    {
      contract: 'confirmed and drawn',
      resolution: confirmed(),
      reason: null,
      flagged: false,
    },
  ] as const)(
    'flags the applied tile while its contract is $contract: $flagged',
    ({ resolution, reason, flagged }) => {
      renderDeck(
        applied('Kodak 2383', SHA_KODAK, resolution, {
          previewLookReason: reason,
        }),
      )
      const flag = within(tile('Kodak 2383')).queryByText(
        'Needs its color contract',
      )
      expect(Boolean(flag)).toBe(flagged)
    },
  )

  it('loads a tapped look and keeps a tap on the applied one a no-op', async () => {
    const sources = sourcesFixture()
    renderDeck(
      applied('Kodak 2383', SHA_KODAK, null, { onlineLutSources: sources }),
    )
    await userEvent.click(tile('Kodak 2383'))
    expect(sources.loadEntry).not.toHaveBeenCalled()

    await userEvent.click(tile('Portra 400'))
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
  })

  it('replaces a look still loading with the newly tapped one, and cancels it from its own tile', async () => {
    const sources = sourcesFixture({ loadingEntryId: 'kodak' })
    renderDeck(look({ onlineLutSources: sources }))

    await userEvent.click(tile('Portra 400'))
    expect(sources.cancelEntryLoad).toHaveBeenCalledOnce()
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
    expect(sources.loadEntry).not.toHaveBeenCalledWith('kodak')

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel download of Kodak 2383' }),
    )
    expect(sources.cancelEntryLoad).toHaveBeenCalledTimes(2)
    expect(sources.loadEntry).toHaveBeenCalledOnce()
  })

  it('names a failed load in the footer and retries from it or the tile', async () => {
    const sources = sourcesFixture({ failedEntryId: 'portra' })
    renderDeck(look({ onlineLutSources: sources }))
    const footer = screen.getByRole('status')
    expect(footer).toHaveTextContent("Couldn't load Portra 400.")

    await userEvent.click(within(footer).getByRole('button', { name: 'Retry' }))
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )

    vi.mocked(sources.loadEntry).mockClear()
    await userEvent.click(
      screen.getByRole('button', {
        name: "Couldn't load Portra 400. Tap to retry.",
      }),
    )
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('portra'),
    )
  })

  it('clears the look from the Original tile and stops a look on its way', async () => {
    const sources = sourcesFixture()
    const controls = applied('Kodak 2383', SHA_KODAK, null, {
      onlineLutSources: sources,
    })
    renderDeck(controls)
    await userEvent.click(tile('Original'))
    expect(sources.cancelEntryLoad).toHaveBeenCalledOnce()
    expect(controls.onLutClear).toHaveBeenCalledOnce()
  })

  it('imports a .cube from its tile and stops a look on its way', async () => {
    const sources = sourcesFixture()
    const controls = look({ onlineLutSources: sources })
    const { container } = renderDeck(controls)
    const input = container.querySelector<HTMLInputElement>(
      'input[type="file"][accept=".cube"]',
    )!
    const pick = vi.spyOn(input, 'click')
    await userEvent.click(tile('Import .cube'))
    expect(pick).toHaveBeenCalledOnce()

    const file = importCube(container, 'mine.cube')
    expect(controls.onLutLoad).toHaveBeenCalledWith([file])
    expect(sources.cancelEntryLoad).toHaveBeenCalled()
  })

  it('holds every tile while the pipeline is busy', () => {
    renderDeck(look({ disabled: true }))
    for (const name of ['Original', 'Kodak 2383', 'Import .cube']) {
      expect(tile(name)).toBeDisabled()
    }
  })

  it('keeps Strength off without a LUT and says why when it is pressed', () => {
    vi.useFakeTimers()
    const { container } = renderDeck()
    const reason = 'Choose a LUT to set its strength'
    expect(strength()).toHaveAttribute('data-disabled')
    expect(strength()).toHaveAccessibleDescription(reason)

    fireEvent.pointerDown(
      container.querySelector('[data-strength-blocked-catcher]')!,
    )
    expect(
      container.querySelector('[data-mobile-look-footer]'),
    ).toHaveTextContent(reason)
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(screen.getByText('No LUT · tone and color only')).toBeInTheDocument()
  })

  it('sets a continuous strength from the stored one, and follows the store', () => {
    seedRawToolStore({ currentLutName: 'Kodak 2383', activeIntensity: 0.62 })
    const controls = applied('Kodak 2383', SHA_KODAK)
    renderDeck(controls)
    expect(strength()).toHaveAttribute('aria-valuenow', '62')

    // Arrows step 1%, Shift+arrows 10%.
    fireEvent.keyDown(strength(), { key: 'ArrowRight' })
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.63)
    fireEvent.keyDown(strength(), { key: 'ArrowLeft', shiftKey: true })
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.52)
    // Away from Standard the value is the reset.
    fireEvent.click(screen.getByRole('button', { name: 'Reset Strength' }))
    expect(controls.onIntensityChange).toHaveBeenLastCalledWith(0.7)

    // The row follows the stored strength without the deck rendering again.
    seedRawToolStore({ currentLutName: 'Kodak 2383', activeIntensity: 0 })
    expect(strength()).toHaveAttribute('aria-valuetext', 'Off')
  })

  it('takes the Adjust focus while Strength scrubs, dimming the strip and the footer', () => {
    const onScrubChange = vi.fn()
    const { container } = render(
      <MobileLookDeck
        look={applied('Kodak 2383', SHA_KODAK)}
        onOpenSources={vi.fn()}
        view="strip"
        onViewChange={vi.fn()}
        onScrubChange={onScrubChange}
      />,
    )
    const row = strength().closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(row)
    expect(onScrubChange).toHaveBeenLastCalledWith({ kind: 'strength' })
    const dimmed = container.querySelectorAll('[data-sibling-scrubbing]')
    expect(dimmed).toHaveLength(2)
    expect(dimmed[0]).toContainElement(
      screen.getByRole('group', { name: 'Looks' }),
    )
    expect(dimmed[1]).toContainElement(
      container.querySelector<HTMLElement>('[data-mobile-look-footer]'),
    )

    fireEvent.pointerUp(row)
    expect(onScrubChange).toHaveBeenLastCalledWith(null)
    expect(container.querySelector('[data-sibling-scrubbing]')).toBeNull()
  })

  it('offers a recommended contract as a one-tap Apply, described as not yet drawn', async () => {
    const controls = applied('SLog3 Look', 'd'.repeat(64), null, {
      lutProfileResolution: recommended(confirmedDisplayLook),
      previewLookReason: 'lut-input-unconfirmed',
    })
    const onViewChange = vi.fn()
    renderDeck(controls, { onViewChange })
    const recommendation = screen.getByRole('button', {
      name: `Recommended: ${confirmedDisplayLook.label}`,
    })
    expect(recommendation).toHaveAccessibleDescription(
      'Not in preview · confirm the LUT input',
    )
    await userEvent.click(screen.getByRole('button', { name: /apply/i }))
    expect(controls.onLutProfileSelect).toHaveBeenCalledWith(
      confirmedDisplayLook,
    )

    await userEvent.click(recommendation)
    expect(onViewChange).toHaveBeenLastCalledWith('contract')
    expect(
      screen.getByRole('region', { name: 'SLog3 Look: input' }),
    ).toBeInTheDocument()
  })

  it.each([
    {
      reason: 'lut-output-transfer-linear',
      resolution: confirmed({
        ...confirmedDisplayLook,
        outputGamut: 'rec2020',
        outputTransfer: 'linear',
      }),
      text: 'Not in preview · linear LUT output not supported',
      side: 'output',
    },
    {
      reason: 'lut-input-unconfirmed',
      resolution: { kind: 'unknown' },
      text: 'Not in preview · confirm the LUT input',
      side: 'input',
    },
  ] as const)(
    'says the preview leaves the look out ($reason) and opens that side of the contract',
    async ({ reason, resolution, text, side }) => {
      const controls = applied('Look', 'e'.repeat(64), resolution, {
        previewLookReason: reason,
      })
      const onViewChange = vi.fn()
      renderDeck(controls, { onViewChange })
      // The look stays selected at its strength; only the preview drops it.
      expect(controls.onLutClear).not.toHaveBeenCalled()
      expect(strength()).not.toHaveAttribute('data-disabled')

      await userEvent.click(screen.getByRole('button', { name: text }))
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
      expect(
        screen.getByRole('region', { name: `Look: ${side}` }),
      ).toBeInTheDocument()
    },
  )

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
    const chooseContract = () =>
      screen.getByRole('button', { name: /choose what this lut expects/i })
    const choose = async (search: string, option: string) => {
      await userEvent.type(screen.getByLabelText('Search LUT contract'), search)
      await userEvent.click(screen.getByRole('button', { name: option }))
    }
    const vLogInput = 'Use Panasonic V-Gamut / V-Log as LUT input'
    /** Settles the pending import a test started. */
    let settle: (outcome: string) => void
    const pendingImport = () =>
      vi.fn(() => new Promise<string>((resolve) => (settle = resolve)))

    it('chooses input then output inside the deck, keeping focus on a control at every step', async () => {
      const controls = unknownFile()
      const onViewChange = vi.fn()
      renderDeck(controls, { onViewChange })

      await userEvent.click(chooseContract())
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toHaveTextContent('1 / 2')
      // No sheet: the contract lives in the deck, with the photo in view.
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(
        screen.getByRole('button', { name: 'Back to looks' }),
      ).toHaveFocus()

      await choose('panasonic', vLogInput)
      const output = screen.getByRole('region', { name: 'client.cube: output' })
      expect(output).toHaveTextContent('2 / 2')
      expect(output).toHaveTextContent('Input: Panasonic V-Gamut / V-Log')
      expect(
        screen.getByRole('button', { name: 'Back to input' }),
      ).toHaveFocus()

      // Back from the output goes to the input, not out of the editor.
      await userEvent.click(
        screen.getByRole('button', { name: 'Back to input' }),
      )
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: vLogInput }))

      await choose('display srgb', 'Use Display sRGB as LUT output')
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
      expect(chooseContract()).toHaveFocus()
    })

    it('applies a complete recommendation in one tap and returns to the strip', async () => {
      const controls = applied('SLog3 Look', 'd'.repeat(64), null, {
        lutProfileResolution: recommended(confirmedDisplayLook),
      })
      const onViewChange = vi.fn()
      renderDeck(controls, { onViewChange, initialView: 'contract' })

      const chips = screen.getByRole('group', { name: 'Recommended input' })
      await userEvent.click(within(chips).getByRole('button'))
      expect(controls.onLutProfileSelect).toHaveBeenCalledWith(
        confirmedDisplayLook,
      )
      expect(onViewChange).toHaveBeenLastCalledWith('strip')
    })

    it.each([
      {
        start: 'drafts an input-only recommendation and moves on',
        resolution: recommended(getLUTColorProfile('panasonic-vgamut-vlog')),
        tapInput: true,
      },
      {
        start: 'starts there when only the output is missing',
        resolution: confirmed(getLUTColorProfile('panasonic-vgamut-vlog')!),
        tapInput: false,
      },
    ])(
      'asks for the output once the input is known: $start',
      async ({ resolution, tapInput }) => {
        const controls = applied('VLog Look', 'e'.repeat(64), resolution)
        renderDeck(controls, { initialView: 'contract' })
        if (tapInput) {
          await userEvent.click(screen.getByRole('button', { name: vLogInput }))
        }
        expect(controls.onLutProfileSelect).not.toHaveBeenCalled()
        expect(
          screen.getByRole('region', { name: 'VLog Look: output' }),
        ).toHaveTextContent('Input: Panasonic V-Gamut / V-Log')
      },
    )

    it('opens the contract by itself once an import nothing resolved lands', () => {
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(look(), { onViewChange })
      importCube(container, 'client.cube')
      expect(onViewChange).not.toHaveBeenCalled()

      // The session reports the imported LUT, its contract unknown.
      rerenderDeck(unknownFile())
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
      expect(
        screen.getByRole('region', { name: 'client.cube: input' }),
      ).toBeInTheDocument()
    })

    it('still opens the contract when the imported LUT lands before the import settles', async () => {
      const onLutLoad = pendingImport()
      const onViewChange = vi.fn()
      const { container, rerenderDeck } = renderDeck(look({ onLutLoad }), {
        onViewChange,
      })
      importCube(container, 'client.cube')
      rerenderDeck({ ...unknownFile(), onLutLoad })
      await act(async () => settle('loaded'))
      expect(onViewChange).toHaveBeenLastCalledWith('contract')
    })

    it.each([
      {
        after: 'an import that failed',
        disarm: async () => {
          // The parse fails: nothing new is applied.
          await act(async () => settle('failed'))
        },
        lands: () => unknownFile(),
      },
      {
        after: 'a strip tile tapped since',
        disarm: () => userEvent.click(tile('Kodak 2383')),
        lands: () => unknownFile(),
      },
      {
        after: 'an import whose contract resolved',
        disarm: async () => {},
        lands: () => applied('Display', '1'.repeat(64), confirmed()),
      },
    ])('leaves the strip alone after $after', async ({ disarm, lands }) => {
      const onViewChange = vi.fn()
      const onLutLoad = pendingImport()
      const { container, rerenderDeck } = renderDeck(look({ onLutLoad }), {
        onViewChange,
      })
      importCube(container, 'client.cube')
      await disarm()

      rerenderDeck(lands())
      expect(onViewChange).not.toHaveBeenCalledWith('contract')
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
