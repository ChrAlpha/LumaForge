import { getLUTColorProfile } from '@lumaforge/luma-color-runtime'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { MobileLabChrome } from './MobileLabChrome'

const base = {
  hasImage: true,
  tone: TONE_NEUTRAL,
  color: COLOR_NEUTRAL,
  selectiveColor: undefined,
  onToneChange: vi.fn(),
  onToneReset: vi.fn(),
  onColorChange: vi.fn(),
  onColorReset: vi.fn(),
  onSelectiveColorChange: vi.fn(),
  onSelectiveColorReset: vi.fn(),
  viewMode: 'processed' as const,
  onViewModeChange: vi.fn(),
  histogram: { state: 'unavailable', reason: 'no-image' } as never,
  fileName: 'DSC09142.ARW',
  fileMeta: 'Sony α7 IV · Official RAW support',
  supportLevel: 'official' as const,
  onReplaceFile: vi.fn(),
  onResetSession: vi.fn(),
  isProcessing: false,
  lutBrowser: {
    currentLutName: null,
    disabled: false,
    onLutLoad: vi.fn(),
    onLutClear: vi.fn(),
    lutProfileSelection: null,
    lutProfileResolution: null,
    onLutProfileSelect: vi.fn(),
    onlineLutSources: undefined,
  },
  exportPanel: ({ onClose }: { onClose: () => void }) => (
    <div>
      export panel
      <button type="button" onClick={onClose}>
        Close export
      </button>
    </div>
  ),
  moreSheet: { pipelineSteps: [], lutRows: [], fileRows: [] },
}

function mountPreviewFrame() {
  const el = document.createElement('div')
  el.setAttribute('data-raw-preview-frame', '')
  document.body.appendChild(el)
  return el
}

describe('mobileLabChrome', () => {
  let previewFrameEl: HTMLDivElement
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
    previewFrameEl = mountPreviewFrame()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    previewFrameEl.remove()
  })

  it('empty state shows the onboarding and one action, with no dock', async () => {
    const onReplaceFile = vi.fn()
    const { container } = render(
      <MobileLabChrome
        {...base}
        hasImage={false}
        onReplaceFile={onReplaceFile}
      />,
    )
    expect(
      container.querySelector('[data-mobile-empty-state]'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /lumaforge raw lab/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: 'Turn one RAW into a finished photo',
      }),
    ).toBeInTheDocument()
    // The topbar subtitle names the product, not a drag gesture.
    expect(
      container.querySelector('[data-mobile-topbar]')!.textContent,
    ).not.toMatch(/drag|drop/i)

    // Nothing for a tool to act on yet: no tab bar at all, not disabled tabs.
    expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()
    expect(container.querySelector('[data-mobile-dock]')).toBeNull()
    await userEvent.click(
      screen.getByRole('button', { name: /browse raw files/i }),
    )
    expect(onReplaceFile).toHaveBeenCalledTimes(1)
  })

  it('mounts the dock once a RAW is open', () => {
    const { rerender } = render(<MobileLabChrome {...base} hasImage={false} />)
    expect(screen.queryByRole('tablist', { name: /lab modes/i })).toBeNull()
    rerender(<MobileLabChrome {...base} />)
    expect(
      screen.getByRole('tablist', { name: /lab modes/i }),
    ).toBeInTheDocument()
  })

  it('shows RAW engine readiness on the mobile empty state and keeps browse available', () => {
    render(
      <MobileLabChrome
        {...base}
        hasImage={false}
        runtimeReadinessState="pending"
      />,
    )

    expect(screen.getByText('Waking RAW engine')).toBeInTheDocument()
    expect(
      screen.getByText(
        'You can choose a file now; processing starts after the engine is ready.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /browse raw files/i }),
    ).toBeEnabled()
  })

  it('shows the CPU preview notice in the chrome, over the empty state, until dismissed', () => {
    const onDismiss = vi.fn()
    const { container, rerender } = render(
      <MobileLabChrome
        {...base}
        hasImage={false}
        cpuPreviewNotice={{ reason: 'webgpu-unavailable', onDismiss }}
      />,
    )

    const chrome = container.querySelector('[data-mobile-lab-chrome]')!
    const notice = within(chrome as HTMLElement).getByRole('status')
    expect(notice).toHaveAttribute('data-cpu-preview-banner')
    expect(notice).toHaveAttribute('data-density', 'compact')
    expect(notice.className).toContain('pointer-events-auto')
    // No lens before a RAW is open, so the notice spans the photo rect,
    // which never starts above the topbar.
    expect(notice).toHaveAttribute('data-placement', 'full')
    expect(notice.style.top).toContain('var(--raw-topbar-height')
    expect(notice.textContent).not.toMatch(/—/)
    // Neutral ink, never amber: a degraded preview is not a colour contract.
    expect(notice.innerHTML).not.toMatch(/amber|color-progress/)
    const dismiss = within(notice).getByRole('button', { name: 'Dismiss' })
    expect(dismiss).toHaveClass('size-11')
    fireEvent.click(dismiss)
    expect(onDismiss).toHaveBeenCalledOnce()

    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(container.querySelector('[data-cpu-preview-banner]')).toBeNull()
  })

  it('sets the CPU preview notice on the photo beside the lens, and clears it for a peek', () => {
    vi.useFakeTimers()
    const { container } = render(
      <MobileLabChrome
        {...base}
        compareSupported={false}
        cpuPreviewNotice={{ reason: 'webgpu-unavailable', onDismiss: vi.fn() }}
      />,
    )
    const notice = container.querySelector<HTMLElement>(
      '[data-cpu-preview-banner]',
    )!
    // The lens is on screen: the notice keeps its column clear.
    expect(notice).toHaveAttribute('data-placement', 'side')
    expect(notice.style.right).toBe('calc(var(--raw-photo-right, 0px) + 48px)')
    expect(notice).not.toHaveClass('opacity-0')

    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    fireEvent.pointerDown(lens)
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(notice).toHaveClass('opacity-0', 'pointer-events-none')
    fireEvent.pointerUp(lens)
    expect(notice).not.toHaveClass('opacity-0')
  })

  it('tears down adjust sheets when the RAW is cleared (hasImage→false)', async () => {
    const { rerender } = render(<MobileLabChrome {...base} />)
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()
    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(
      screen.queryByRole('group', { name: /tone sliders/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /browse raw files/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /lumaforge raw lab/i }),
    ).toBeInTheDocument()
  })

  it('look mode opens the LUT sources and dock has no strength tab', async () => {
    render(<MobileLabChrome {...base} />)
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(within(dock).getAllByRole('tab')).toHaveLength(2)
    expect(
      within(dock).queryByRole('tab', { name: /strength/i }),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /lut sources/i }))
    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()
  })

  it('surfaces the export panel when the result handoff should own mobile focus', async () => {
    render(
      <MobileLabChrome
        {...base}
        preferExportMode
        exportPanel={() => <div>ready export actions</div>}
      />,
    )

    expect(await screen.findByText('ready export actions')).toBeInTheDocument()
    expect(screen.queryByText('No LUT yet, tone only.')).not.toBeInTheDocument()
    // Export borrows the deck; no tool tab claims the panel on screen.
    expect(
      screen.queryByRole('tab', { selected: true }),
    ).not.toBeInTheDocument()
  })

  it('hands the deck back to a tool when one is tapped while export is open', async () => {
    render(
      <MobileLabChrome
        {...base}
        preferExportMode
        exportPanel={() => <div>ready export actions</div>}
      />,
    )
    expect(await screen.findByText('ready export actions')).toBeInTheDocument()

    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))

    expect(screen.queryByText('ready export actions')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
    expect(within(dock).getByRole('tab', { name: /look/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('keeps the mobile topbar and toolbar visible while processing replaces the preview layer', () => {
    const { container } = render(<MobileLabChrome {...base} isProcessing />)

    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveClass(
      'pointer-events-none',
    )
    expect(screen.getByRole('banner')).toBeInTheDocument()
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(within(dock).getByRole('tab', { name: /look/i })).toBeDisabled()
    expect(within(dock).getByRole('tab', { name: /adjust/i })).toBeDisabled()
  })

  it('closes transient mobile sheets when the blocking handoff starts', async () => {
    const { rerender } = render(<MobileLabChrome {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /lut sources/i }))
    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()

    rerender(<MobileLabChrome {...base} isProcessing />)

    expect(
      screen.queryByRole('dialog', { name: /lut browser/i }),
    ).not.toBeInTheDocument()
  })

  it('keeps the branded topbar and toolbar while the preview remains released after export', () => {
    const { container } = render(<MobileLabChrome {...base} previewSuspended />)

    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveClass(
      'pointer-events-none',
    )
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: /lab modes/i }),
    ).toBeInTheDocument()
  })

  it('keeps export result actions in the normal toolbar while the preview remains released', () => {
    const { container } = render(
      <MobileLabChrome
        {...base}
        previewSuspended
        preferExportMode
        exportPanel={() => <button type="button">Download JPEG</button>}
      />,
    )

    expect(
      container.querySelector('[data-mobile-released-export-actions]'),
    ).toBeNull()
    expect(
      screen.getByRole('button', { name: /download jpeg/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: /lab modes/i }),
    ).toBeInTheDocument()
  })

  it('surfaces the current mobile LUT contract directly in Look mode', async () => {
    const detectedProfile = {
      ...getLUTColorProfile('sony-sgamut3cine-slog3')!,
      role: 'combined-look-output' as const,
      outputGamut: 'srgb-rec709' as const,
      outputTransfer: 'srgb' as const,
      outputRange: 'full' as const,
    }

    render(
      <MobileLabChrome
        {...base}
        lutBrowser={{
          ...base.lutBrowser,
          currentLutName: 'client-look.cube',
          lutProfileSelection: {
            status: 'confirmed',
            fingerprint: 'lut-fingerprint',
            profileId: detectedProfile.id,
            confidence: 'metadata',
          },
          lutProfileResolution: {
            kind: 'confirmed',
            profile: detectedProfile,
            confidence: 'metadata',
          },
        }}
      />,
    )

    // The applied file is a tile on the strip, pressed.
    expect(
      screen.getByRole('button', { name: 'client-look.cube' }),
    ).toHaveAttribute('aria-pressed', 'true')
    // A confirmed contract reads as one quiet line in the footer.
    const confirmed = screen.getByRole('button', {
      name: /edit color contract for sony s-gamut3\.cine \/ s-log3/i,
    })
    expect(confirmed).toHaveTextContent(
      'Sony S-Gamut3.Cine / S-Log3 → Rec.709 display',
    )
    expect(confirmed.className).not.toMatch(/amber/)

    // Tapping it opens the contract editor inline, in the deck: no sheet
    // over the photo, and the deck takes list sizing so the photo stays.
    await userEvent.click(confirmed)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('region', { name: 'client-look.cube: input' }),
    ).toBeInTheDocument()
    expect(document.querySelector('[data-mobile-dock-panel]')).toHaveAttribute(
      'data-deck-fill',
      'true',
    )

    // Leaving it returns the strip at its natural height.
    await userEvent.click(screen.getByRole('button', { name: 'Back to looks' }))
    expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
    expect(
      document.querySelector('[data-mobile-dock-panel]'),
    ).not.toHaveAttribute('data-deck-fill')
  })

  it('opens the LUT sources at their default view from the Look footer', async () => {
    render(<MobileLabChrome {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /lut sources/i }))

    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('tablist', { name: 'LUT contract panels' }),
    ).not.toBeInTheDocument()
  })

  it('keeps the mobile LUT contract entry visible when auto-detection fails', async () => {
    render(
      <MobileLabChrome
        {...base}
        lutBrowser={{
          ...base.lutBrowser,
          currentLutName: 'unknown-look.cube',
          lutProfileSelection: {
            status: 'unknown',
            fingerprint: 'lut-fingerprint',
            title: 'Unknown look',
            sourceName: 'unknown-look.cube',
          },
          lutProfileResolution: {
            kind: 'unknown',
          },
        }}
      />,
    )

    const choose = screen.getByRole('button', {
      name: /choose what this lut expects/i,
    })
    // Amber here explains a colour contract that still needs a choice.
    expect(choose.className).toContain('text-lf-amber-soft')

    await userEvent.click(choose)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(
      screen.getByRole('region', { name: 'unknown-look.cube: input' }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Search LUT contract')).toBeInTheDocument()
  })

  it('routes a LUT-contract export block to the Look contract view', async () => {
    render(
      <MobileLabChrome
        {...base}
        preferExportMode
        lutBrowser={{
          ...base.lutBrowser,
          currentLutName: 'unknown-look.cube',
          lutProfileResolution: { kind: 'unknown' },
        }}
        exportPanel={({ onChooseLutContract }) => (
          <button type="button" onClick={onChooseLutContract}>
            Choose LUT contract
          </button>
        )}
      />,
    )
    await userEvent.click(
      await screen.findByRole('button', { name: 'Choose LUT contract' }),
    )

    // Export hands the deck to Look, opened on the contract.
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(within(dock).getByRole('tab', { name: /look/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      screen.getByRole('region', { name: 'unknown-look.cube: input' }),
    ).toBeInTheDocument()

    // Switching tools hands Look back its strip next time.
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))
    expect(screen.getByRole('group', { name: 'Looks' })).toBeInTheDocument()
  })

  it('starts with controls visible on the Look workflow, not bare', async () => {
    render(<MobileLabChrome {...base} />)
    // Controls are present on load — dock expanded by default, not immersive.
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // Tapping the active Look tab collapses the panel.
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))
    expect(screen.queryByRole('button', { name: /lut sources/i })).toBeNull()
  })

  it('opens Adjust inline with tone sliders and keeps the topbar visible', async () => {
    render(<MobileLabChrome {...base} />)
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()

    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))

    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('slider')).toHaveLength(6)
    // The topbar stays present — no focus editor takeover.
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
  })

  it('shows the scrub HUD and flags the chrome while a slider is dragged', async () => {
    const { container } = render(<MobileLabChrome {...base} />)
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    const exposureRow = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    expect(container.querySelector('[data-scrub-value-hud]')).toBeNull()
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-focus',
      'false',
    )
    expect(dock).not.toHaveAttribute('data-scrubbing')

    fireEvent.pointerDown(exposureRow)
    expect(
      container.querySelector('[data-scrub-value-hud]'),
    ).toBeInTheDocument()
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-focus',
      'true',
    )
    expect(dock).toHaveAttribute('data-scrubbing', 'true')
    expect(dock).toHaveClass('opacity-45')

    fireEvent.pointerUp(exposureRow)
    await waitFor(() =>
      expect(container.querySelector('[data-scrub-value-hud]')).toBeNull(),
    )
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-focus',
      'false',
    )
    expect(dock).not.toHaveAttribute('data-scrubbing')
  })

  it('opens Adjust color controls without adding a dock mode', async () => {
    render(
      <MobileLabChrome
        {...base}
        color={{ ...COLOR_NEUTRAL, userTemperature: 24, userTint: -12 }}
      />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(within(dock).getAllByRole('tab')).toHaveLength(2)

    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))

    expect(
      screen.getByRole('group', { name: /color sliders/i }),
    ).toBeInTheDocument()
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(4)
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Temperature',
      'Tint',
      'Saturation',
      'Vibrance',
    ])
    expect(screen.getByText('+24')).toBeInTheDocument()
    expect(screen.getByText('-12')).toBeInTheDocument()
    expect(within(dock).queryByRole('tab', { name: /color/i })).toBeNull()
    expect(within(dock).queryByRole('tab', { name: /tone/i })).toBeNull()
  })

  it('short tap toggles immersive (chrome hidden) and back', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    expect(screen.getByRole('heading', { name: 'DSC09142.ARW' })).toBeVisible()
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    // Panel collapses first; immersive engages after the stagger.
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.queryByRole('heading', { name: 'DSC09142.ARW' }),
    ).not.toBeInTheDocument()
    // restore affordance brings the chrome back immediately
    fireEvent.click(screen.getByRole('button', { name: /show controls/i }))
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // flush the pending panel re-expand before restoring real timers
    act(() => {
      vi.advanceTimersByTime(160)
    })
    vi.useRealTimers()
  })

  it('collapses the dock panel before receding into immersive', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    // Dock panel is expanded by default (Look mode) — its LUT button is present.
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })

    // Phase 1: panel collapsed, but chrome (topbar) is still present.
    expect(screen.queryByRole('button', { name: /lut sources/i })).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()

    // Phase 2: after the stagger, chrome recedes into immersive.
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.queryByRole('heading', { name: 'DSC09142.ARW' }),
    ).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('re-expands the dock panel when leaving immersive', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.queryByRole('heading', { name: 'DSC09142.ARW' }),
    ).not.toBeInTheDocument()
    // Exit: chrome returns immediately, the panel re-expands after the stagger.
    fireEvent.click(screen.getByRole('button', { name: /show controls/i }))
    expect(screen.queryByRole('button', { name: /lut sources/i })).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps the panel-restore intent through a rapid double-tap into immersive', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
    // Tap 1 begins the collapse→recede stagger.
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    // Tap 2 within the stagger window completes immersive immediately.
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(
      screen.queryByRole('heading', { name: 'DSC09142.ARW' }),
    ).not.toBeInTheDocument()
    // Exiting must still restore the panel that was open before immersive.
    fireEvent.click(screen.getByRole('button', { name: /show controls/i }))
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('tap on the exposed preview closes an open sheet instead of toggling immersive', async () => {
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    await userEvent.click(screen.getByRole('button', { name: /lut sources/i }))
    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })

    // The sheet closes; immersive does NOT engage (topbar still present).
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /lut browser/i }),
      ).not.toBeInTheDocument(),
    )
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
  })

  it('suppresses long-press peek while a sheet is open', () => {
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    // Open the LUT browser synchronously, then drive the hold on fake timers.
    // fireEvent (sync) is intentional: lutBrowserOpen must be set before we
    // switch to fake timers below. userEvent.click is async and can't be
    // awaited before vi.useFakeTimers() in the same test.
    fireEvent.click(screen.getByRole('button', { name: /lut sources/i }))
    vi.useFakeTimers()
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(400)
    })
    expect(onViewModeChange).not.toHaveBeenCalledWith('original')
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    vi.useRealTimers()
  })

  it('peeks the unprocessed RAW via viewMode while held', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(260)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    vi.useRealTimers()
  })

  it('cancels long-press peek when a second finger lands so pinch can take over', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    const first = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(first, 'pointerId', { value: 1 })
    previewFrameEl.dispatchEvent(first)
    const second = new Event('pointerdown', { bubbles: true })
    Object.defineProperty(second, 'pointerId', { value: 2 })
    previewFrameEl.dispatchEvent(second)
    vi.advanceTimersByTime(500)
    expect(onViewModeChange).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
  it('puts the export action at the far right of the topbar, after More', () => {
    const { container } = render(<MobileLabChrome {...base} canExport />)
    const topbar = container.querySelector('[data-mobile-topbar]')!
    const buttons = within(topbar as HTMLElement).getAllByRole('button')
    const action = buttons.at(-1)!
    expect(action).toHaveAttribute('data-mobile-export-action')
    expect(action).toHaveAttribute('data-state', 'ready')
    expect(action).toHaveAccessibleName('Export ready: open options')
    expect(buttons.at(-2)).toHaveAccessibleName(/more actions/i)
  })

  it('has no export action before a RAW is loaded', () => {
    const { container } = render(<MobileLabChrome {...base} hasImage={false} />)
    expect(container.querySelector('[data-mobile-export-action]')).toBeNull()
  })

  it('opens the export panel in the deck from the topbar and returns to the last tool', async () => {
    const { container } = render(<MobileLabChrome {...base} />)
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))

    const action = container.querySelector<HTMLButtonElement>(
      '[data-mobile-export-action]',
    )!
    // Blocked export is still tappable: the panel explains why.
    expect(action).toHaveAttribute('data-state', 'idle')
    expect(action).toBeEnabled()
    expect(action).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(action)
    expect(screen.getByText('export panel')).toBeInTheDocument()
    expect(
      screen.queryByRole('group', { name: /tone sliders/i }),
    ).not.toBeInTheDocument()
    expect(action).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.queryByRole('tab', { selected: true }),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close export' }))
    expect(screen.queryByText('export panel')).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()
    expect(action).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggles the export panel closed from the action while it is open', async () => {
    const { container } = render(<MobileLabChrome {...base} />)
    const action = container.querySelector<HTMLButtonElement>(
      '[data-mobile-export-action]',
    )!
    await userEvent.click(action)
    expect(screen.getByText('export panel')).toBeInTheDocument()
    await userEvent.click(action)
    expect(screen.queryByText('export panel')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /lut sources/i }),
    ).toBeInTheDocument()
  })

  it('keeps the export panel on screen while an export runs, and shows progress on the action', async () => {
    const { container, rerender } = render(
      <MobileLabChrome {...base} canExport />,
    )
    const action = container.querySelector<HTMLButtonElement>(
      '[data-mobile-export-action]',
    )!
    await userEvent.click(action)
    expect(screen.getByText('export panel')).toBeInTheDocument()

    rerender(
      <MobileLabChrome
        {...base}
        canExport={false}
        isProcessing
        isExporting
        exportProgress={42.4}
      />,
    )
    const busy = container.querySelector<HTMLButtonElement>(
      '[data-mobile-export-action]',
    )!
    expect(busy).toHaveAttribute('data-state', 'exporting')
    expect(busy).toHaveAccessibleName('Exporting 42%')
    expect(busy).toBeEnabled()
    expect(screen.getByText('export panel')).toBeInTheDocument()
    expect(
      within(screen.getByRole('tablist', { name: /lab modes/i })).getByRole(
        'tab',
        { name: /look/i },
      ),
    ).toBeDisabled()
  })

  it('disables the export action while the pipeline is busy with something other than export', () => {
    const { container } = render(<MobileLabChrome {...base} isProcessing />)
    expect(
      container.querySelector('[data-mobile-export-action]'),
    ).toBeDisabled()
  })

  it('marks a finished export on the action and opens the result', async () => {
    const { container } = render(
      <MobileLabChrome
        {...base}
        hasExportResult
        exportPanel={() => <div>result actions</div>}
      />,
    )
    const action = container.querySelector<HTMLButtonElement>(
      '[data-mobile-export-action]',
    )!
    expect(action).toHaveAttribute('data-state', 'done')
    expect(action).toHaveAccessibleName('Exported: open result')
    await userEvent.click(action)
    expect(screen.getByText('result actions')).toBeInTheDocument()
  })
  it('puts the compare lens over the stage only when there is a photo to compare', () => {
    const { container, rerender } = render(<MobileLabChrome {...base} />)
    const lens = container.querySelector('[data-mobile-compare-lens]')
    expect(lens).toHaveAccessibleName('Split compare')
    expect(lens).toHaveAttribute('data-state', 'off')
    expect(
      container
        .querySelector('[data-mobile-lab-chrome]')!
        .getAttribute('style'),
    ).toContain('--raw-compare-lens-top')

    // The CPU preview has no split surface: the lens stays, as an original
    // toggle.
    rerender(<MobileLabChrome {...base} compareSupported={false} />)
    const cpuLens = container.querySelector('[data-mobile-compare-lens]')
    expect(cpuLens).toHaveAccessibleName('Show original')
    expect(cpuLens).toHaveAttribute('data-lens-mode', 'original')

    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(container.querySelector('[data-mobile-compare-lens]')).toBeNull()
  })

  it('makes the lens an original toggle in the CPU preview, and a hold still peeks', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome
        {...base}
        compareSupported={false}
        onViewModeChange={onViewModeChange}
      />,
    )
    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    expect(lens).toHaveAttribute('aria-pressed', 'false')

    // A tap pins the original; there is no split to open.
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    expect(onViewModeChange).not.toHaveBeenCalledWith('compare')
    expect(lens).toHaveAttribute('aria-pressed', 'true')
    expect(lens).toHaveAttribute('data-state', 'on')
    expect(lens).toHaveAccessibleName('Show original')

    // A hold peeks and its release hands back the pinned original.
    fireEvent.pointerDown(lens)
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-peek',
      'true',
    )
    fireEvent.pointerUp(lens)
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    expect(lens).toHaveAttribute('aria-pressed', 'true')

    // A second tap shows the processed photo again.
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    expect(lens).toHaveAttribute('aria-pressed', 'false')

    // Unpinned, a hold returns to the processed photo.
    fireEvent.pointerDown(lens)
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    fireEvent.pointerUp(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
  })

  it('keeps the split on while switching tools', async () => {
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome {...base} onViewModeChange={onViewModeChange} />,
    )
    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')
    expect(lens).toHaveAttribute('aria-pressed', 'true')
    expect(lens).toHaveAttribute('data-state', 'on')
    onViewModeChange.mockClear()

    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))

    expect(onViewModeChange).not.toHaveBeenCalledWith('processed')
    expect(lens).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    expect(lens).toHaveAttribute('aria-pressed', 'false')
  })

  it('peeks the unprocessed RAW while the lens is held, then restores the split', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome {...base} onViewModeChange={onViewModeChange} />,
    )
    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')

    fireEvent.pointerDown(lens)
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-peek',
      'true',
    )
    expect(screen.getByText('Showing unprocessed RAW')).toBeInTheDocument()

    fireEvent.pointerUp(lens)
    fireEvent.click(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')
    expect(lens).toHaveAttribute('aria-pressed', 'true')
    expect(
      container.querySelector('[data-mobile-lab-chrome]'),
    ).not.toHaveAttribute('data-peek')
  })

  it('returns a lens peek to the processed view when the split is off', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome {...base} onViewModeChange={onViewModeChange} />,
    )
    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    fireEvent.pointerDown(lens)
    act(() => {
      vi.advanceTimersByTime(260)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    fireEvent.pointerUp(lens)
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    expect(lens).toHaveAttribute('aria-pressed', 'false')
  })

  it('blocks the lens while a Transform is applied and says why', () => {
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome
        {...base}
        transform={{ active: true, demo: { manual: undefined } } as never}
        onViewModeChange={onViewModeChange}
      />,
    )
    const lens = container.querySelector<HTMLElement>(
      '[data-mobile-compare-lens]',
    )!
    expect(lens).toHaveAttribute('data-state', 'disabled')
    expect(lens).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(lens)
    expect(onViewModeChange).not.toHaveBeenCalledWith('compare')
    expect(
      container.querySelector('[data-mobile-compare-lens-hint="blocked"]'),
    ).toHaveTextContent('Transform applied: compare is unavailable')
  })

  it('hides the lens during a scrub, while processing, and in immersive', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { container, rerender } = render(
      <MobileLabChrome {...base} previewFrameEl={previewFrameEl} />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    fireEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
    const exposureRow = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(exposureRow)
    await waitFor(() =>
      expect(container.querySelector('[data-mobile-compare-lens]')).toBeNull(),
    )
    fireEvent.pointerUp(exposureRow)
    await waitFor(() =>
      expect(
        container.querySelector('[data-mobile-compare-lens]'),
      ).not.toBeNull(),
    )

    rerender(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        isProcessing
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('[data-mobile-compare-lens]')).toBeNull(),
    )
    rerender(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    await waitFor(() =>
      expect(
        container.querySelector('[data-mobile-compare-lens]'),
      ).not.toBeNull(),
    )

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    act(() => {
      vi.advanceTimersByTime(160)
    })
    await waitFor(() =>
      expect(container.querySelector('[data-mobile-compare-lens]')).toBeNull(),
    )
  })
})

describe('mobileLabChrome stage layout', () => {
  const restore: Array<() => void> = []

  function stubGeometry(heights: Record<string, number>) {
    const sizeOf = (el: Element) =>
      Object.entries(heights).find(([selector]) => el.matches(selector))?.[1]
    for (const [prop, read] of [
      [
        'clientWidth',
        (el: HTMLElement) => (el.hasAttribute('data-raw-lab-shell') ? 393 : 0),
      ],
      [
        'clientHeight',
        (el: HTMLElement) => (el.hasAttribute('data-raw-lab-shell') ? 660 : 0),
      ],
      ['offsetHeight', (el: HTMLElement) => sizeOf(el) ?? 0],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(
        HTMLElement.prototype,
        prop,
      )
      Object.defineProperty(HTMLElement.prototype, prop, {
        configurable: true,
        get(this: HTMLElement) {
          return read(this)
        },
      })
      restore.push(() => {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, prop, original)
        }
      })
    }
  }

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        unobserve: vi.fn(),
        disconnect: vi.fn(),
      })),
    )
    stubGeometry({
      '[data-mobile-topbar]': 56,
      '[data-mobile-dock]': 64,
      // Look's content; the deck adds 24px of padding.
      '[data-mobile-deck-content]': 116,
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    while (restore.length) restore.pop()!()
  })

  function renderInShell(
    props: Partial<Parameters<typeof MobileLabChrome>[0]>,
  ) {
    const result = render(
      <div data-raw-lab-shell="viewport">
        <MobileLabChrome {...base} {...props} />
      </div>,
    )
    const shell = result.container.querySelector<HTMLElement>(
      '[data-raw-lab-shell]',
    )!
    const px = (name: string) =>
      Number.parseFloat(shell.style.getPropertyValue(name))
    const deck = () =>
      result.container.querySelector<HTMLElement>('[data-mobile-dock-panel]')
    return { ...result, shell, px, deck }
  }

  async function openAdjust() {
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /adjust/i }))
  }

  it('anchors a landscape photo under the topbar and keeps it there across tools', async () => {
    const { px, deck } = renderInShell({ photoAspect: 3 / 2 })
    expect(px('--raw-stage-inset-top')).toBe(56)
    expect(px('--raw-stage-inset-bottom')).toBeCloseTo(660 - 56 - 262)
    expect(px('--raw-photo-top')).toBe(56)
    expect(px('--raw-photo-width')).toBeCloseTo(393)
    expect(px('--raw-photo-height')).toBeCloseTo(262)
    expect(px('--raw-photo-right')).toBeCloseTo(0)
    expect(deck()!.style.height).toBe('140px')

    await openAdjust()
    expect(px('--raw-stage-inset-bottom')).toBeCloseTo(660 - 56 - 262)
    expect(Number.parseFloat(deck()!.style.height)).toBeCloseTo(250.8)
  })

  it('trades height between a portrait photo and the deck, but never on a scrub', async () => {
    const { container, px, deck } = renderInShell({ photoAspect: 2 / 3 })
    // Look: 660 - 56 - 64 - 140 = 400px of photo, ~267px wide, centred.
    expect(px('--raw-photo-height')).toBeCloseTo(400)
    expect(px('--raw-photo-width')).toBeCloseTo(266.67, 1)
    expect(px('--raw-photo-left')).toBeCloseTo(63.17, 1)
    expect(px('--raw-photo-right')).toBeCloseTo(63.17, 1)
    expect(px('--raw-stage-inset-bottom')).toBeCloseTo(204)

    await openAdjust()
    expect(deck()!.style.height).toBe('200px')
    expect(px('--raw-photo-height')).toBeCloseTo(340)
    const restingInset = px('--raw-stage-inset-bottom')
    expect(restingInset).toBeCloseTo(264)

    const exposureRow = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(exposureRow)
    expect(
      container.querySelector('[data-scrub-value-hud]'),
    ).toBeInTheDocument()
    expect(px('--raw-stage-inset-bottom')).toBe(restingInset)
    expect(deck()!.style.height).toBe('200px')
    fireEvent.pointerUp(exposureRow)
    expect(px('--raw-stage-inset-bottom')).toBe(restingInset)
  })

  it('collapses the deck and gives the photo the room', async () => {
    const { px } = renderInShell({ photoAspect: 2 / 3 })
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    // Tapping the active tool collapses the deck.
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))
    expect(px('--raw-photo-height')).toBeCloseTo(540)
    expect(px('--raw-photo-width')).toBeCloseTo(360)
    expect(px('--raw-stage-inset-bottom')).toBeCloseTo(64)
  })

  it('falls back to the region above the deck while the aspect is unknown', async () => {
    const { px, deck } = renderInShell({ photoAspect: null })
    await openAdjust()
    expect(Number.parseFloat(deck()!.style.height)).toBeCloseTo(250.8)
    expect(px('--raw-stage-inset-bottom')).toBeCloseTo(64 + 250.8)
  })

  it('flips the lens hint below the lens on a photo too narrow to hold it beside', async () => {
    localStorage.clear()
    const { container, rerender } = renderInShell({ photoAspect: 2 / 3 })
    const slot = () =>
      container
        .querySelector('[data-mobile-compare-lens-hint-slot]')!
        .getAttribute('data-mobile-compare-lens-hint-slot')
    // 2:3 in Look is ~267px wide: room beside the lens.
    expect(slot()).toBe('side')
    expect(
      container.querySelector('[data-mobile-compare-lens-hint="intro"]'),
    ).not.toBeNull()

    // 9:16 in Adjust is ~191px wide: the hint drops below the lens.
    rerender(
      <div data-raw-lab-shell="viewport">
        <MobileLabChrome {...base} photoAspect={9 / 16} />
      </div>,
    )
    await openAdjust()
    expect(slot()).toBe('below')
  })

  it('keeps the peek pill clear of the lens, dropping below its row on a narrow photo', () => {
    vi.useFakeTimers()
    try {
      const { container, rerender } = renderInShell({ photoAspect: 3 / 2 })
      const lens = () =>
        container.querySelector<HTMLElement>('[data-mobile-compare-lens]')!
      const holdLens = () => {
        fireEvent.pointerDown(lens())
        act(() => {
          vi.advanceTimersByTime(260)
        })
      }
      const pill = () => container.querySelector('[data-mobile-peek-hint]')

      holdLens()
      // A full-width landscape photo holds the pill in the lens's row.
      expect(pill()).toHaveAttribute('data-mobile-peek-hint', 'row')
      expect(pill()).toHaveClass(
        'max-w-[calc(var(--raw-photo-width,100vw)-96px)]',
      )
      fireEvent.pointerUp(lens())

      rerender(
        <div data-raw-lab-shell="viewport">
          <MobileLabChrome {...base} photoAspect={2 / 3} />
        </div>,
      )
      holdLens()
      expect(pill()).toHaveAttribute('data-mobile-peek-hint', 'below')
      fireEvent.pointerUp(lens())
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the peek label in immersive, where the lens has gone', () => {
    vi.useFakeTimers()
    const previewFrameEl = mountPreviewFrame()
    try {
      const { container } = renderInShell({
        photoAspect: 2 / 3,
        previewFrameEl,
      })
      act(() => {
        previewFrameEl.dispatchEvent(
          new Event('pointerdown', { bubbles: true }),
        )
        previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
      })
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(container.querySelector('[data-mobile-compare-lens]')).toBeNull()
      act(() => {
        previewFrameEl.dispatchEvent(
          new Event('pointerdown', { bubbles: true }),
        )
        vi.advanceTimersByTime(260)
      })
      const pill = container.querySelector('[data-mobile-peek-hint]')
      expect(pill).toHaveAttribute('data-mobile-peek-hint', 'row')
      // Clear of the status bar over a full-bleed photo.
      expect(pill!.className).toContain('env(safe-area-inset-top)')
      act(() => {
        previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
      })
    } finally {
      previewFrameEl.remove()
      vi.useRealTimers()
    }
  })

  it('returns the stage to full bleed without an image and clears its variables on unmount', () => {
    const { px, shell, unmount } = renderInShell({
      hasImage: false,
      photoAspect: null,
    })
    expect(px('--raw-stage-inset-top')).toBe(0)
    expect(px('--raw-stage-inset-bottom')).toBe(0)
    unmount()
    expect(shell.style.getPropertyValue('--raw-stage-inset-bottom')).toBe('')
    expect(shell.style.getPropertyValue('--raw-photo-top')).toBe('')
  })
})
