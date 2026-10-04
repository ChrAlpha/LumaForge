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
  onCompareReset: vi.fn(),
  exportPanel: <div>export</div>,
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

  it('empty state keeps onboarding upload affordance between topbar and toolbar', async () => {
    const onReplaceFile = vi.fn()
    const { container } = render(
      <MobileLabChrome
        {...base}
        hasImage={false}
        onReplaceFile={onReplaceFile}
      />,
    )
    expect(
      container.querySelector('[data-mobile-empty-hero]'),
    ).toBeInTheDocument()
    expect(
      container.querySelector('[data-mobile-empty-prestage]'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /lumaforge raw lab/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /finish a raw with a lut/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /finish a raw with a lut/i })
        .parentElement,
    ).toHaveClass('raw-mobile-empty-copy-block')

    expect(
      screen.getByRole('tablist', { name: /lab modes/i }),
    ).toBeInTheDocument()
    await userEvent.click(
      screen.getByRole('button', { name: /browse raw files/i }),
    )
    expect(onReplaceFile).toHaveBeenCalledTimes(1)
    expect(
      screen.queryByRole('tablist', { name: /tone parameters/i }),
    ).toBeNull()
  })

  it('shows RAW engine readiness on the mobile empty state and disables browse until ready', () => {
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
    ).toBeDisabled()
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
    expect(notice.className).toContain('pointer-events-auto')
    fireEvent.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()

    rerender(<MobileLabChrome {...base} hasImage={false} />)
    expect(container.querySelector('[data-cpu-preview-banner]')).toBeNull()
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

  it('look mode opens the LUT browser and dock has no strength tab', async () => {
    render(<MobileLabChrome {...base} />)
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    expect(within(dock).getAllByRole('tab')).toHaveLength(4)
    expect(
      within(dock).queryByRole('tab', { name: /strength/i }),
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /lut browser/i }))
    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()
  })

  it('surfaces the export panel when the result handoff should own mobile focus', async () => {
    render(
      <MobileLabChrome
        {...base}
        preferExportMode
        exportPanel={<div>ready export actions</div>}
      />,
    )

    expect(await screen.findByText('ready export actions')).toBeInTheDocument()
    expect(screen.queryByText('No LUT yet, tone only.')).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /export/i })).toHaveAttribute(
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
    expect(within(dock).getByRole('tab', { name: /export/i })).toBeDisabled()
  })

  it('closes transient mobile sheets when the blocking handoff starts', async () => {
    const { rerender } = render(<MobileLabChrome {...base} />)

    await userEvent.click(screen.getByRole('button', { name: /lut browser/i }))
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
        exportPanel={<button type="button">Download JPEG</button>}
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

    expect(screen.getByText('client-look.cube')).toBeInTheDocument()
    expect(screen.getByText('Sony S-Gamut3.Cine / S-Log3')).toBeInTheDocument()
    expect(screen.getByText('Rec.709 display')).toBeInTheDocument()

    // Primary action swaps the LUT itself — must be the most prominent affordance.
    expect(
      screen.getByRole('button', {
        name: /change lut: browse, upload, or load a different lut/i,
      }),
    ).toBeInTheDocument()

    // Tapping the contract row deep-links to the contract editor.
    await userEvent.click(
      screen.getByRole('button', {
        name: /edit color contract for sony s-gamut3\.cine \/ s-log3/i,
      }),
    )

    expect(
      screen.getByRole('dialog', { name: /edit contract/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('tablist', { name: 'LUT contract panels' }),
    ).toBeInTheDocument()
  })

  it('opens the LUT browser at the default view when changing LUT from Look mode', async () => {
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

    await userEvent.click(
      screen.getByRole('button', {
        name: /change lut: browse, upload, or load a different lut/i,
      }),
    )

    expect(
      screen.getByRole('dialog', { name: /lut browser/i }),
    ).toBeInTheDocument()
    // The contract editor stays collapsed — default view shows the LUT roster.
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

    expect(
      screen.getByText(
        'Choose the LUT input and output contract before preview or export.',
      ),
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: /choose lut contract/i }),
    )

    expect(
      screen.getByRole('dialog', { name: /edit contract/i }),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('Search LUT contract')).toBeInTheDocument()
  })

  it('starts with controls visible on the Look workflow, not bare', async () => {
    render(<MobileLabChrome {...base} />)
    // Controls are present on load — dock expanded by default, not immersive.
    expect(
      screen.getByRole('button', { name: /lut browser/i }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'DSC09142.ARW' }),
    ).toBeInTheDocument()
    // Tapping the active Look tab collapses the panel.
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    await userEvent.click(within(dock).getByRole('tab', { name: /look/i }))
    expect(screen.queryByRole('button', { name: /lut browser/i })).toBeNull()
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
    expect(within(dock).getAllByRole('tab')).toHaveLength(4)

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
      screen.getByRole('button', { name: /lut browser/i }),
    ).toBeInTheDocument()

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })

    // Phase 1: panel collapsed, but chrome (topbar) is still present.
    expect(screen.queryByRole('button', { name: /lut browser/i })).toBeNull()
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
    expect(screen.queryByRole('button', { name: /lut browser/i })).toBeNull()
    act(() => {
      vi.advanceTimersByTime(160)
    })
    expect(
      screen.getByRole('button', { name: /lut browser/i }),
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps the panel-restore intent through a rapid double-tap into immersive', () => {
    vi.useFakeTimers()
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    expect(
      screen.getByRole('button', { name: /lut browser/i }),
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
      screen.getByRole('button', { name: /lut browser/i }),
    ).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('tap on the exposed preview closes an open sheet instead of toggling immersive', async () => {
    render(<MobileLabChrome {...base} previewFrameEl={previewFrameEl} />)
    await userEvent.click(screen.getByRole('button', { name: /lut browser/i }))
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
    fireEvent.click(screen.getByRole('button', { name: /lut browser/i }))
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

  it('uses long-press peek as the default Compare interaction', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    fireEvent.click(within(dock).getByRole('tab', { name: /compare/i }))
    expect(screen.getByText(/touch and hold the photo/i)).toBeInTheDocument()
    expect(screen.queryByText('compare')).not.toBeInTheDocument()

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(400)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    vi.useRealTimers()
  })

  it('enables split compare only through the explicit Compare panel action', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    fireEvent.click(within(dock).getByRole('tab', { name: /compare/i }))
    expect(
      screen.queryByText(/pins raw and final jpeg/i),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /split compare/i }))
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')
    expect(screen.getByText(/pins raw and final jpeg/i)).toBeInTheDocument()

    onViewModeChange.mockClear()
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(400)
    })
    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(onViewModeChange).not.toHaveBeenCalledWith('original')

    fireEvent.click(
      screen.getByRole('button', { name: /touch and hold instead/i }),
    )
    expect(onViewModeChange).toHaveBeenLastCalledWith('processed')
    expect(screen.getByText(/touch and hold the photo/i)).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps split compare active when opened from an active long-press peek', () => {
    vi.useFakeTimers()
    const onViewModeChange = vi.fn()
    const { container } = render(
      <MobileLabChrome
        {...base}
        previewFrameEl={previewFrameEl}
        onViewModeChange={onViewModeChange}
      />,
    )
    const dock = screen.getByRole('tablist', { name: /lab modes/i })
    fireEvent.click(within(dock).getByRole('tab', { name: /compare/i }))

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(400)
    })
    expect(onViewModeChange).toHaveBeenLastCalledWith('original')
    expect(container.querySelector('[data-mobile-lab-chrome]')).toHaveAttribute(
      'data-peek',
      'true',
    )

    fireEvent.click(screen.getByRole('button', { name: /split compare/i }))
    expect(onViewModeChange).toHaveBeenLastCalledWith('compare')
    expect(
      container.querySelector('[data-mobile-lab-chrome]'),
    ).not.toHaveAttribute('data-peek')

    act(() => {
      previewFrameEl.dispatchEvent(new Event('pointerup', { bubbles: true }))
    })
    expect(onViewModeChange.mock.calls.map(([mode]) => mode)).toEqual([
      'original',
      'compare',
    ])
    vi.useRealTimers()
  })
})
