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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { viewportWidthAtom } from '~/atoms/viewport'
import { jotaiStore } from '~/lib/jotai'

import type { UseOnlineLutSourcesResult } from '../hooks/useOnlineLutSources'
import { createMockExportResultIdentity } from '../model/export-result.fixture'
import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../state/tool-card.atoms'
import { LutDropzone } from './Dropzone'
import { renderRawToolSurface } from './raw-tool-surface.fixture'
import { toolAvailabilityFixture } from './tool-availability.fixture'

const STAGED_LUT_HINT =
  'Add a .cube LUT now, it stays staged until a RAW file is loaded.'

function catalogEntry(id: string, title: string) {
  return {
    id,
    resourceId: 'source-1',
    title,
    sourceUrl: `https://profiles.example.com/entries/${id}.json`,
    sourceType: 'catalog-entry' as const,
    cube: {
      url: `https://profiles.example.com/blobs/${id}.cube`,
      sha256: 'a'.repeat(64),
    },
    tags: [],
  }
}

/** One ready catalog of five LUTs, none applied. */
function onlineLutSourcesFixture(
  overrides: Partial<UseOnlineLutSourcesResult> = {},
): UseOnlineLutSourcesResult {
  return {
    state: {
      resources: [
        {
          id: 'source-1',
          url: 'https://profiles.example.com/catalog.json',
          type: 'catalog',
          label: 'Catalog from profiles.example.com',
          fromQuery: true,
        },
      ],
      entries: [
        catalogEntry('kodak-2383-rec709', 'Kodak 2383 Rec.709'),
        catalogEntry('ektachrome-e100', 'Ektachrome E100'),
        catalogEntry('portra-400', 'Portra 400'),
        catalogEntry('vision3-250d', 'Vision3 250D'),
        catalogEntry('velvia-50', 'Velvia 50'),
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
    share: { enabled: false, url: '/raw', copy: vi.fn() },
    ...overrides,
  }
}

function resetToolCards() {
  act(() => {
    jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS)
  })
}

describe('rawToolSurface', () => {
  let previousViewport = jotaiStore.get(viewportWidthAtom)
  beforeEach(() => {
    localStorage.clear()
    resetToolCards()
    previousViewport = jotaiStore.get(viewportWidthAtom)
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
    jotaiStore.set(viewportWidthAtom, previousViewport)
    resetToolCards()
    localStorage.clear()
  })

  const showMobile = () => jotaiStore.set(viewportWidthAtom, 390)

  it('mounts the desktop rail at a desktop width: its card stack and a persistent export block', () => {
    const { container } = renderRawToolSurface()
    expect(container.querySelector('[data-raw-mobile-lab]')).toBeNull()
    expect(
      screen.getByRole('group', { name: 'RAW finishing controls' }),
    ).toBeInTheDocument()
    expect(
      Array.from(container.querySelectorAll('[data-tool-card]'), (card) =>
        card.getAttribute('data-tool-card'),
      ),
    ).toEqual(['histogram', 'look', 'adjust', 'compare', 'fileFacts'])
    expect(screen.getByRole('region', { name: 'Export' })).toHaveAttribute(
      'data-raw-export-block',
      'persistent',
    )
  })

  it.each([
    { state: 'before a RAW', hasImage: false },
    { state: 'with a RAW', hasImage: true },
  ])(
    'mounts the photo-first mobile shell at a phone width $state',
    ({ hasImage }) => {
      showMobile()
      const { container } = renderRawToolSurface({ hasImage })
      // The shell lets touches through to the stage outside its controls.
      expect(container.querySelector('[data-raw-mobile-lab]')).toHaveClass(
        'pointer-events-none',
      )
      expect(
        container.querySelector('[data-raw-tool-surface="raw-finishing"]'),
      ).toBeNull()
      expect(container.querySelector('[data-mobile-topbar]')).not.toBeNull()
      // The dock arrives with a RAW to act on; until then, the onboarding.
      expect(
        screen.queryByRole('tablist', { name: /lab modes/i }) !== null,
      ).toBe(hasImage)
      expect(
        container.querySelector('[data-mobile-empty-state]') !== null,
      ).toBe(!hasImage)
    },
  )

  it('draws desktop Adjust from the store and edits it through the tool commands, each reset scoped to its section', async () => {
    const user = userEvent.setup()
    const handlers = {
      hasImage: true,
      onToneChange: vi.fn(),
      onToneReset: vi.fn(),
      onColorReset: vi.fn(),
    }
    const view = renderRawToolSurface(handlers)
    const adjust = () => screen.getByRole('region', { name: 'Adjust' })
    const reset = (name: string) =>
      within(adjust()).getByRole('button', { name })
    expect(reset('Reset tone')).toBeDisabled()
    expect(reset('Reset color')).toBeDisabled()
    expect(within(adjust()).queryByText('Tone settings preserved')).toBeNull()

    view.rerender({
      ...handlers,
      tone: { userContrast: 12 },
      color: { userTemperature: 18 },
    })
    expect(
      within(adjust()).getByText('Tone settings preserved'),
    ).toBeInTheDocument()
    within(adjust()).getByRole('slider', { name: 'Exposure' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(handlers.onToneChange).toHaveBeenLastCalledWith({
      userExposureEv: 0.01,
    })
    within(adjust()).getByRole('slider', { name: 'Highlights' }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(handlers.onToneChange).toHaveBeenLastCalledWith({
      userHighlights: -1,
    })
    await user.click(reset('Reset tone'))
    expect(handlers.onToneReset).toHaveBeenCalledOnce()
    expect(handlers.onColorReset).not.toHaveBeenCalled()
    await user.click(reset('Reset color'))
    expect(handlers.onColorReset).toHaveBeenCalledOnce()
    expect(handlers.onToneReset).toHaveBeenCalledOnce()
  })

  it.each([
    { name: 'open', refuse: false },
    { name: 'refused', refuse: true },
  ])(
    'draws the desktop rail controls from the availability it is handed: $name',
    async ({ refuse }) => {
      const user = userEvent.setup()
      const onCompareReset = vi.fn()
      // Facts that leave every control open: the policy is what the rail draws.
      const open = toolAvailabilityFixture({
        hasImage: true,
        currentLutName: 'look.cube',
      })
      const refused = {
        available: false as const,
        reason: 'export-running' as const,
      }
      renderRawToolSurface({
        hasImage: true,
        currentLutName: 'look.cube',
        onCompareReset,
        toolAvailability: refuse
          ? {
              ...open,
              desktop: {
                ...open.desktop,
                edit: refused,
                strength: refused,
                lutApplication: refused,
                splitReset: refused,
              },
            }
          : open,
      })

      for (const slider of [
        within(screen.getByRole('region', { name: 'Adjust' })).getByRole(
          'slider',
          { name: 'Exposure' },
        ),
        screen.getByRole('slider', { name: 'Strength' }),
      ]) {
        expect(slider.hasAttribute('data-disabled')).toBe(refuse)
      }
      expect(
        screen.getByLabelText<HTMLInputElement>(/add \.cube lut/i).disabled,
      ).toBe(refuse)
      await user.click(screen.getByRole('button', { name: 'Compare' }))
      const compareReset = screen.getByRole<HTMLButtonElement>('button', {
        name: 'Reset compare view',
      })
      expect(compareReset.disabled).toBe(refuse)
      await user.click(compareReset)
      expect(onCompareReset).toHaveBeenCalledTimes(refuse ? 0 : 1)
    },
  )

  it('sets a continuous strength on the desktop rail from the stored look, with presets as detents', () => {
    const onIntensityChange = vi.fn()
    const look = { hasImage: true, currentLutName: 'Sony Look.cube' }
    const view = renderRawToolSurface({
      ...look,
      activeIntensity: 0.62,
      onIntensityChange,
    })
    const row = view.container.querySelector<HTMLElement>(
      '[data-raw-desktop-strength="row"]',
    )!
    const strength = within(row).getByRole('slider', { name: 'Strength' })
    expect(strength).toHaveAttribute('aria-valuetext', '62%')
    expect(row.querySelector('[data-slider-tick-labels]')).toHaveTextContent(
      'LightStandardStrong',
    )
    fireEvent.keyDown(strength, { key: 'ArrowRight' })
    expect(onIntensityChange).toHaveBeenLastCalledWith(0.63)
    // The amber value returns it to Standard.
    fireEvent.click(within(row).getByRole('button', { name: 'Reset Strength' }))
    expect(onIntensityChange).toHaveBeenLastCalledWith(0.7)

    // A new stored strength moves the slider on screen, not a new one.
    view.rerender({ ...look, activeIntensity: 0, onIntensityChange })
    expect(screen.getByRole('slider', { name: 'Strength' })).toBe(strength)
    expect(strength).toHaveAttribute('aria-valuetext', 'Off')
  })

  it.each([
    { state: 'before a RAW', hasImage: false, reason: '', staged: true },
    {
      state: 'with a RAW',
      hasImage: true,
      reason: 'Choose a LUT to set its strength',
      staged: false,
    },
  ])(
    'keeps Strength off without an applied LUT, and LUT upload open beside the online sources, $state',
    ({ hasImage, reason, staged }) => {
      const onIntensityChange = vi.fn()
      renderRawToolSurface({
        hasImage,
        onlineLutSources: onlineLutSourcesFixture(),
        onIntensityChange,
      })
      expect(screen.getByLabelText(/add \.cube lut/i)).toBeEnabled()
      expect(screen.queryByText(STAGED_LUT_HINT) !== null).toBe(staged)
      const strength = screen.getByRole('slider', { name: 'Strength' })
      expect(strength).toHaveAttribute('data-disabled')
      expect(strength).toHaveAccessibleDescription(reason)
      fireEvent.keyDown(strength, { key: 'ArrowRight' })
      expect(onIntensityChange).not.toHaveBeenCalled()
    },
  )

  it('draws the histogram its own provider hands the desktop card', async () => {
    const user = userEvent.setup()
    const bins = new Uint32Array(256)
    bins[0] = 1
    bins[255] = 1
    renderRawToolSurface({
      hasImage: true,
      histogram: {
        state: 'ready',
        source: 'quick',
        width: 2,
        height: 1,
        sampledPixels: 2,
        totalPixels: 2,
        bins: {
          luma: bins,
          red: bins,
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

    await user.click(screen.getByRole('button', { name: 'Histogram' }))
    const [card] = await screen.findAllByRole('region', { name: 'Histogram' })
    expect(
      within(card).getByLabelText('Preview luminance and RGB histogram'),
    ).toBeInTheDocument()
  })

  it('lists an online source as a summary row with its first LUTs inline, and loads one on a tap', async () => {
    const user = userEvent.setup()
    const sources = onlineLutSourcesFixture()
    const { container } = renderRawToolSurface({ onlineLutSources: sources })
    expect(screen.getByText('5 LUTs')).toBeInTheDocument()
    // The fifth waits in the full catalog, which stays closed.
    expect(screen.queryByText('Velvia 50')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()

    const inline = container.querySelector<HTMLElement>(
      '[data-raw-lut="source-inline-entries"]',
    )!
    await user.click(
      within(inline).getByRole('button', { name: 'Load Kodak 2383 Rec.709' }),
    )
    await waitFor(() =>
      expect(sources.loadEntry).toHaveBeenCalledWith('kodak-2383-rec709'),
    )
  })

  it('closes the online LUT browser once the look it loads has applied', async () => {
    const user = userEvent.setup()
    let finishLoad = () => {}
    const loadEntry = vi.fn(
      () =>
        new Promise<'loaded'>((resolve) => {
          finishLoad = () => resolve('loaded')
        }),
    )
    renderRawToolSurface({
      onlineLutSources: onlineLutSourcesFixture({ loadEntry }),
    })
    await user.click(
      screen.getByRole('button', {
        name: 'Open Catalog from profiles.example.com',
      }),
    )
    const browser = screen.getByRole('dialog', {
      name: 'Catalog from profiles.example.com LUTs',
    })
    await user.click(
      within(browser).getByRole('button', { name: /load kodak 2383 rec.709/i }),
    )
    await waitFor(() =>
      expect(loadEntry).toHaveBeenCalledWith('kodak-2383-rec709'),
    )
    expect(browser).toBeInTheDocument()

    await act(async () => finishLoad())
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps a long LUT name whole in its title', () => {
    const name =
      'Fujifilm-GFX100RF-F-Log2C-to-Classic-Negative-Rec709-Display-Extremely-Long-Client-Delivery-Name.cube'
    render(<LutDropzone currentLut={name} onFileDrop={vi.fn()} />)
    expect(screen.getByText(name)).toHaveAttribute('title', name)
  })

  it('hands the mobile shell its policy and the delivery commands: a released preview locks the tools and keeps every delivery action', async () => {
    const user = userEvent.setup()
    showMobile()
    const delivery = {
      onDownloadExport: vi.fn(),
      onDownloadExportManifest: vi.fn(),
      onShareExport: vi.fn(),
      onCopyExport: vi.fn(),
    }
    renderRawToolSurface({
      ...delivery,
      hasImage: true,
      canExport: true,
      previewSuspended: true,
      exportShareCapability: { available: true },
      exportResult: {
        kind: 'full-resolution',
        identity: createMockExportResultIdentity({
          source: { name: 'DSC09142.ARW', size: 1000, lastModified: 0 },
        }),
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
          reasonCode: 'full-resolution-copy-unsupported',
        },
        manifestState: { status: 'ready' },
      },
    })
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    for (const tab of within(dock).getAllByRole('tab')) {
      expect(tab).toBeDisabled()
    }

    // The result opens on its own, and every delivery action reaches its
    // command.
    await user.click(await screen.findByRole('button', { name: 'Download' }))
    await user.click(
      screen.getByRole('button', { name: 'Download render manifest (JSON)' }),
    )
    await user.click(screen.getByRole('button', { name: 'Share' }))
    await user.click(
      screen.getByRole('button', { name: 'Copy preview-size image' }),
    )
    for (const command of Object.values(delivery)) {
      expect(command).toHaveBeenCalledOnce()
    }
  })
})
