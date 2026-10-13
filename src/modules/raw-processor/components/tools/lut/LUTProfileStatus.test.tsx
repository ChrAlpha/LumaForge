import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { jotaiStore } from '~/lib/jotai'

import {
  DEFAULT_OPEN_TOOL_CARDS,
  toolCardOpenAtom,
} from '../../../state/tool-card.atoms'
import type { RawToolSurfaceFixtureProps } from '../../raw-tool-surface.fixture'
import { renderRawToolSurface } from '../../raw-tool-surface.fixture'

/** A loaded RAW on the desktop rail; each test states its LUT contract. */
function surfaceProps(
  overrides: RawToolSurfaceFixtureProps = {},
): RawToolSurfaceFixtureProps {
  return {
    fileName: 'DSC09142.ARW',
    hasImage: true,
    canExport: false,
    disabledReason: { source: 'workflow', reason: { code: 'source-loading' } },
    supportLevel: 'experimental',
    ...overrides,
  }
}

function mockTriggerRect(element: HTMLElement, rect: Partial<DOMRect>) {
  return vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    bottom: rect.bottom ?? 64,
    height: rect.height ?? 32,
    left: rect.left ?? 24,
    right: rect.right ?? 56,
    top: rect.top ?? 32,
    width: rect.width ?? 32,
    x: rect.x ?? rect.left ?? 24,
    y: rect.y ?? rect.top ?? 32,
    toJSON: () => ({}),
  } satisfies DOMRect)
}

async function clickOverlayAt(
  x: number,
  y: number,
  elementsAtPoint: Element[] = [],
) {
  const overlay = document.querySelector('[data-raw-lut-browser-overlay]')
  expect(overlay).toBeInTheDocument()
  const previousElementsFromPoint = document.elementsFromPoint
  const elementsFromPoint = vi.fn(() => [
    overlay as Element,
    ...elementsAtPoint,
  ])
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: elementsFromPoint,
  })

  try {
    await act(async () => {
      fireEvent.pointerDown(overlay as HTMLElement, {
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.pointerUp(overlay as HTMLElement, {
        button: 0,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
      })
      fireEvent.click(overlay as HTMLElement, {
        button: 0,
        clientX: x,
        clientY: y,
      })
      await Promise.resolve()
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
  } finally {
    if (previousElementsFromPoint) {
      Object.defineProperty(document, 'elementsFromPoint', {
        configurable: true,
        value: previousElementsFromPoint,
      })
    } else {
      Reflect.deleteProperty(document, 'elementsFromPoint')
    }
  }
}

describe('desktop LUT contract status', () => {
  beforeEach(() => {
    localStorage.clear()
    act(() => jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    act(() => jotaiStore.set(toolCardOpenAtom, DEFAULT_OPEN_TOOL_CARDS))
    localStorage.clear()
  })

  it('keeps pending LUT suggestions collapsed until the contract browser opens', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()
    const profile = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Sony Look.cube',
        lutProfileSelection: {
          status: 'recommended',
          fingerprint: 'abc123',
          title: 'Sony Look',
          recommendations: [profile],
        },
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [profile],
        },
        onLutProfileSelect,
      }),
    )

    // With a complete recommendation the component surfaces inline rows + recommended note
    expect(
      screen.getByText(
        'Inferred from the file name/metadata — confirm before export.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    // Full suggestion list not rendered inline - only the top recommendation is shown
    expect(
      screen.queryByText('Sony S-Gamut3.Cine / S-Log3 -> Rec.709 display'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    expect(browser).toHaveAttribute('data-raw-lut-browser-dialog', 'contract')
    expect(
      within(browser).getByRole('tablist', { name: 'LUT contract panels' }),
    ).toBeInTheDocument()
    expect(
      within(browser).getAllByText('Sony S-Gamut3.Cine / S-Log3').length,
    ).toBeGreaterThanOrEqual(1)
    expect(
      within(browser).getByLabelText('Search LUT contract'),
    ).toBeInTheDocument()
    expect(
      within(browser).getByRole('button', {
        name: 'Use Sony S-Gamut3.Cine / S-Log3 as LUT input',
      }),
    ).toBeInTheDocument()
  })

  it('closes the LUT contract browser from the outside layer and restores focus', async () => {
    const user = userEvent.setup()
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')!

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Sony Look.cube',
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'toggle-contract',
          profileId: profile.id,
          confidence: 'metadata',
        },
        lutProfileResolution: {
          kind: 'confirmed',
          profile,
          confidence: 'metadata',
        },
      }),
    )

    const trigger = screen.getByRole('button', {
      name: 'Change LUT contract',
    })

    await user.click(trigger)
    expect(
      screen.getByRole('dialog', { name: 'LUT contract browser' }),
    ).toBeInTheDocument()

    const overlay = document.querySelector('[data-raw-lut-browser-overlay]')
    expect(overlay).toBeInTheDocument()
    await user.click(overlay as HTMLElement)

    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()
  })

  it('lets the open LUT contract trigger toggle through the modal layer', async () => {
    const user = userEvent.setup()
    const profile = getLUTColorProfile('sony-sgamut3cine-slog3')!

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Sony Look.cube',
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'toggle-contract',
          profileId: profile.id,
          confidence: 'metadata',
        },
        lutProfileResolution: {
          kind: 'confirmed',
          profile,
          confidence: 'metadata',
        },
      }),
    )

    const trigger = screen.getByRole('button', {
      name: 'Change LUT contract',
    })
    const getRect = mockTriggerRect(trigger, {
      left: 40,
      right: 196,
      top: 80,
      bottom: 112,
    })

    await user.click(trigger)
    expect(
      screen.getByRole('dialog', { name: 'LUT contract browser' }),
    ).toBeInTheDocument()

    await clickOverlayAt(80, 96, [trigger])

    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(trigger).toHaveFocus()

    getRect.mockRestore()
  })

  it('shows resolved LUT input and output contracts', () => {
    const profile = {
      ...getLUTColorProfile('panasonic-vgamut-vlog')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Panasonic Look.cube',
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'abc123',
          profileId: profile.id,
          confidence: 'metadata',
        },
        lutProfileResolution: {
          kind: 'confirmed',
          profile,
          confidence: 'metadata',
        },
      }),
    )

    expect(screen.getByText('LUT input:')).toBeInTheDocument()
    expect(screen.getByText('Panasonic V-Gamut / V-Log')).toBeInTheDocument()
    expect(screen.getByText('LUT output:')).toBeInTheDocument()
    expect(screen.getByText('Rec.709 display')).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()
  })

  it('makes missing LUT output contracts explicit', () => {
    const profile = getLUTColorProfile('panasonic-vgamut-vlog')!

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Panasonic Look.cube',
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'abc123',
          profileId: profile.id,
          confidence: 'metadata',
        },
        lutProfileResolution: {
          kind: 'confirmed',
          profile,
          confidence: 'metadata',
        },
      }),
    )

    expect(screen.getByText(/choose the LUT output/i)).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    ).toBeInTheDocument()
  })

  it('resets selector state and search when switching LUT fingerprints', async () => {
    const user = userEvent.setup()
    const sonyProfile = getLUTColorProfile('sony-sgamut3cine-slog3')!
    const canonProfile = getLUTColorProfile('canon-cinema-gamut-clog3')!

    const firstLutProps = surfaceProps({
      currentLutName: 'Sony Look.cube',
      lutProfileSelection: {
        status: 'confirmed',
        fingerprint: 'first-lut',
        profileId: sonyProfile.id,
        confidence: 'metadata',
      },
      lutProfileResolution: {
        kind: 'confirmed',
        profile: sonyProfile,
        confidence: 'metadata',
      },
    })
    const { rerender } = renderRawToolSurface(firstLutProps)

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )
    await user.type(screen.getByLabelText('Search LUT contract'), 'panasonic')

    expect(screen.getByLabelText('Search LUT contract')).toHaveValue(
      'panasonic',
    )
    expect(
      screen.queryByText('ARRI Wide Gamut 4 / LogC4'),
    ).not.toBeInTheDocument()

    rerender(
      surfaceProps({
        currentLutName: 'Canon Look.cube',
        lutProfileSelection: {
          status: 'confirmed',
          fingerprint: 'second-lut',
          profileId: canonProfile.id,
          confidence: 'metadata',
        },
        lutProfileResolution: {
          kind: 'confirmed',
          profile: canonProfile,
          confidence: 'metadata',
        },
      }),
    )

    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    expect(screen.getByLabelText('Search LUT contract')).toHaveValue('')
    expect(screen.getByText('ARRI Wide Gamut 4 / LogC4')).toBeInTheDocument()
  })

  it('uses a dedicated LUT contract browser with separate input and output panels', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Unknown Look.cube',
        lutProfileSelection: {
          status: 'unknown',
          fingerprint: 'def456',
          title: 'Unknown Look',
          sourceName: 'Unknown Look.cube',
        },
        lutProfileResolution: {
          kind: 'unknown',
        },
        onLutProfileSelect,
      }),
    )

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    expect(browser).toBeInTheDocument()
    expect(
      within(browser).getByRole('tab', { name: 'Input', selected: true }),
    ).toBeInTheDocument()
    expect(
      within(browser).getByRole('tab', { name: 'Output', selected: false }),
    ).toBeInTheDocument()

    await user.type(
      within(browser).getByLabelText('Search LUT contract'),
      'v-log',
    )

    const vLogInputButton = within(browser).getByRole('button', {
      name: 'Use Panasonic V-Gamut / V-Log as LUT input',
    })
    expect(vLogInputButton).toBeInTheDocument()
    expect(
      within(browser).queryByRole('button', {
        name: 'Panasonic V-Gamut / V-Log -> Rec.709 display',
      }),
    ).not.toBeInTheDocument()

    await user.click(vLogInputButton)

    expect(
      within(browser).getByRole('tab', { name: 'Output', selected: true }),
    ).toBeInTheDocument()

    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Panasonic V-Gamut / V-Log as LUT output',
      }),
    )

    expect(onLutProfileSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'panasonic-vgamut-vlog',
        role: 'scene-creative',
        inputGamut: 'v-gamut',
        inputTransfer: 'v-log',
        outputGamut: 'v-gamut',
        outputTransfer: 'v-log',
        outputRange: 'full',
      }),
    )
    expect(
      screen.queryByRole('dialog', { name: 'LUT contract browser' }),
    ).not.toBeInTheDocument()
  })

  it('passes the full suggested LUT contract when a LUT input is chosen', async () => {
    const user = userEvent.setup()
    const onLutProfileSelect = vi.fn()
    const suggestion = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'bt709' as const,
      outputRange: 'full' as const,
    }

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Unknown Look.cube',
        lutProfileSelection: {
          status: 'recommended',
          fingerprint: 'ghi789',
          title: 'Unknown Look',
          recommendations: [suggestion],
        },
        lutProfileResolution: {
          kind: 'recommended',
          recommendations: [suggestion],
        },
        onLutProfileSelect,
      }),
    )

    await user.click(
      screen.getByRole('button', { name: 'Change LUT contract' }),
    )

    const browser = screen.getByRole('dialog', { name: 'LUT contract browser' })
    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Sony S-Gamut3.Cine / S-Log3 as LUT input',
      }),
    )
    await user.click(
      within(browser).getByRole('button', {
        name: 'Use Rec.709 display as LUT output',
      }),
    )

    expect(onLutProfileSelect).toHaveBeenCalledWith(suggestion)
  })

  it('warns unsupported output LUTs without showing the input selector', () => {
    const suggestion = getLUTColorProfile('sony-sgamut3cine-slog3')!

    renderRawToolSurface(
      surfaceProps({
        currentLutName: 'Cineon Output.cube',
        lutProfileSelection: {
          status: 'unsupported-output',
          fingerprint: 'jkl012',
          title: 'Cineon Output',
          recommendations: [suggestion],
        },
        lutProfileResolution: {
          kind: 'unsupported-output',
          recommendations: [suggestion],
        },
      }),
    )

    expect(
      screen.getByText(/This LUT output is not supported yet/),
    ).toBeInTheDocument()
    expect(
      screen.queryByLabelText('Search LUT contract'),
    ).not.toBeInTheDocument()
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

    renderRawToolSurface({
      ...surfaceProps(),
      currentLutName: 'SLog3SGamut3.CineToLC_709.cube',
      lutProfileSelection: {
        status: 'confirmed',
        fingerprint: 'stable-catalog-lut',
        profileId: resolvedProfile.id,
        confidence: 'metadata',
      },
      lutProfileResolution: {
        kind: 'confirmed',
        profile: resolvedProfile,
        confidence: 'metadata',
      },
    })

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

    renderRawToolSurface({
      ...surfaceProps(),
      currentLutName: 'stable-catalog-look.cube',
      lutProfileSelection: {
        status: 'recommended',
        fingerprint: 'stable-catalog-look',
        title: 'Stable catalog look',
        recommendations: [sonyProfile, panasonicProfile],
      },
      lutProfileResolution: {
        kind: 'recommended',
        recommendations: [sonyProfile, panasonicProfile],
      },
    })

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

  it('renders input and output rows with apply-contract button for a complete recommendation', async () => {
    const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')!
    const completeProfile = {
      ...vlog709,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'gamma24' as const,
      outputRange: 'full' as const,
    }

    renderRawToolSurface({
      ...surfaceProps(),
      currentLutName: 'VLog-to-Rec709.cube',
      lutProfileSelection: {
        status: 'recommended',
        fingerprint: 'vlog-rec709',
        title: 'VLog to Rec.709',
        recommendations: [completeProfile],
      },
      lutProfileResolution: {
        kind: 'recommended',
        recommendations: [completeProfile],
      },
    })

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

    renderRawToolSurface({
      ...surfaceProps(),
      currentLutName: 'VLog-to-Rec709.cube',
      onLutProfileSelect,
      lutProfileSelection: {
        status: 'recommended',
        fingerprint: 'vlog-rec709',
        title: 'VLog to Rec.709',
        recommendations: [completeProfile],
      },
      lutProfileResolution: {
        kind: 'recommended',
        recommendations: [completeProfile],
      },
    })

    await user.click(screen.getByRole('button', { name: 'Use this contract' }))

    expect(onLutProfileSelect).toHaveBeenCalledWith(completeProfile)
  })

  it('renders choose-output button for input-only recommendation and opens browser on click', async () => {
    const user = userEvent.setup()
    const vlog709 = getLUTColorProfile('panasonic-vgamut-vlog')!

    renderRawToolSurface({
      ...surfaceProps(),
      currentLutName: 'VLog-Look.cube',
      lutProfileSelection: {
        status: 'recommended',
        fingerprint: 'vlog-look',
        title: 'VLog Look',
        recommendations: [vlog709],
      },
      lutProfileResolution: {
        kind: 'recommended',
        recommendations: [vlog709],
      },
    })

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
