import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enMessages from '~/locales/en.json'

import { COLOR_NEUTRAL } from '../color-fields'
import { TONE_NEUTRAL } from '../tone-fields'
import { AdjustListPanel } from './AdjustListPanel'

function neutralBands(): Record<HSLBandId, HSLBandShift> {
  return {
    red: makeNeutralBand(),
    orange: makeNeutralBand(),
    yellow: makeNeutralBand(),
    green: makeNeutralBand(),
    aqua: makeNeutralBand(),
    blue: makeNeutralBand(),
    purple: makeNeutralBand(),
    magenta: makeNeutralBand(),
  }
}

describe('adjustListPanel', () => {
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
  })

  function renderPanel(
    overrides: Partial<React.ComponentProps<typeof AdjustListPanel>> = {},
  ) {
    const props = {
      tone: { ...TONE_NEUTRAL, userContrast: 10 },
      color: { ...COLOR_NEUTRAL, userTemperature: 24 },
      selectiveColor: neutralBands(),
      onToneChange: vi.fn(),
      onColorChange: vi.fn(),
      onSelectiveColorChange: vi.fn(),
      onToneReset: vi.fn(),
      onColorReset: vi.fn(),
      onSelectiveColorReset: vi.fn(),
      onScrubChange: vi.fn(),
      ...overrides,
    }
    render(<AdjustListPanel {...props} />)
    return props
  }

  it('starts on Tone and shows the six tone sliders + segment reset button', () => {
    renderPanel()
    expect(
      screen.getByRole('group', { name: /tone sliders/i }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('slider')).toHaveLength(6)
    // Tabs row + ghost reset are the new low-chrome chrome — both must keep
    // the 44px mobile touch target without leaning on a dark scrim chip.
    expect(screen.getByRole('tablist', { name: /adjust/i })).toHaveClass(
      'min-h-11',
    )
    expect(screen.getByRole('button', { name: /reset tone/i })).toHaveClass(
      'min-h-11',
      'min-w-11',
    )
    expect(screen.getByRole('button', { name: /reset tone/i })).toBeEnabled()
    // The active tab carries the amber underline indicator; the chrome row
    // wears a single hairline divider instead of a free-floating dark chip.
    const toneTab = screen.getByRole('tab', { name: /^tone$/i })
    expect(toneTab).toHaveAttribute('aria-selected', 'true')
    expect(toneTab.querySelector('span[aria-hidden="true"]')).toHaveClass(
      'bg-lf-amber',
    )
    expect(document.querySelector('[data-adjust-section-chrome]')).toHaveClass(
      'border-b',
      'border-lf-on-photo-bord-soft',
    )
    // The chrome lives in a flex column as a non-shrinking header above an
    // independent scroll region — the slider list scrolls inside its own
    // container and never crosses the chrome. That removes the need for
    // an opaque "obscurer" bg, so the bar stays a delicate frosted glass.
    expect(document.querySelector('[data-adjust-section-chrome]')).toHaveClass(
      'shrink-0',
      '-mx-3.5',
      'bg-[oklch(0.118_0.006_255/0.40)]',
      'backdrop-blur-xl',
    )
    expect(document.querySelector('[data-adjust-list-scroll]')).toHaveClass(
      'overflow-y-auto',
      'flex-1',
      'min-h-0',
    )
  })

  it('switches to Color and shows the four color sliders', async () => {
    renderPanel()
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))
    expect(
      screen.getByRole('group', { name: /color sliders/i }),
    ).toBeInTheDocument()
    expect(screen.getAllByRole('slider')).toHaveLength(4)
    expect(screen.getByRole('button', { name: /reset color/i })).toBeEnabled()
  })

  it('exposes three subpanel tabs in Tone → Color → HSL order', () => {
    renderPanel()
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.map((t) => t.textContent)).toEqual([
      enMessages['raw.adjust.tone'],
      enMessages['raw.adjust.color'],
      enMessages['raw.adjust.hsl'],
    ])
  })

  it('switches to HSL and mounts the band-list view (closed by default)', async () => {
    renderPanel()
    await userEvent.click(
      screen.getByRole('tab', { name: enMessages['raw.adjust.hsl'] }),
    )
    expect(
      screen.getByRole('group', { name: /hsl bands/i }),
    ).toBeInTheDocument()
    // Two-level: bands are closed initially, no sliders revealed.
    expect(screen.queryAllByRole('slider')).toHaveLength(0)
    expect(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.red'] }),
    ).toBeInTheDocument()
  })

  it('disables the section reset when the active section is neutral', async () => {
    renderPanel({
      tone: TONE_NEUTRAL,
      color: COLOR_NEUTRAL,
      selectiveColor: neutralBands(),
    })
    expect(screen.getByRole('button', { name: /reset tone/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))
    expect(screen.getByRole('button', { name: /reset color/i })).toBeDisabled()
    await userEvent.click(
      screen.getByRole('tab', { name: enMessages['raw.adjust.hsl'] }),
    )
    expect(
      screen.getByRole('button', { name: enMessages['raw.hsl.reset'] }),
    ).toBeDisabled()
  })

  it('section reset calls the section-scoped handler only', async () => {
    const props = renderPanel({
      selectiveColor: {
        ...neutralBands(),
        green: { hue: 6, saturation: 0, lightness: 0 },
      },
    })
    await userEvent.click(screen.getByRole('button', { name: /reset tone/i }))
    expect(props.onToneReset).toHaveBeenCalledTimes(1)
    expect(props.onColorReset).not.toHaveBeenCalled()
    expect(props.onSelectiveColorReset).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))
    await userEvent.click(screen.getByRole('button', { name: /reset color/i }))
    expect(props.onColorReset).toHaveBeenCalledTimes(1)
    expect(props.onSelectiveColorReset).not.toHaveBeenCalled()
    await userEvent.click(
      screen.getByRole('tab', { name: enMessages['raw.adjust.hsl'] }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.reset'] }),
    )
    expect(props.onSelectiveColorReset).toHaveBeenCalledTimes(1)
  })

  it('child scrub events bubble out with the section kind', () => {
    const props = renderPanel()
    const exposureRow = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(exposureRow)
    expect(props.onScrubChange).toHaveBeenLastCalledWith({
      kind: 'tone',
      key: 'userExposureEv',
    })
    fireEvent.pointerUp(exposureRow)
    expect(props.onScrubChange).toHaveBeenLastCalledWith(null)
  })

  it('hSL scrub events bubble out with kind=hsl, band, and key', async () => {
    const props = renderPanel()
    await userEvent.click(
      screen.getByRole('tab', { name: enMessages['raw.adjust.hsl'] }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.red'] }),
    )
    const sliders = screen.getAllByRole('slider')
    const hueScrub = sliders[0].closest(
      '[data-testid="adjust-slider-row-scrub"]',
    )!
    fireEvent.pointerDown(hueScrub)
    expect(props.onScrubChange).toHaveBeenLastCalledWith({
      kind: 'hsl',
      band: 'red',
      key: 'hue',
    })
    fireEvent.pointerUp(hueScrub)
    expect(props.onScrubChange).toHaveBeenLastCalledWith(null)
  })

  it('clears any in-flight scrub when the segment is switched', async () => {
    const onScrubChange = vi.fn()
    renderPanel({ onScrubChange })
    const exposureRow = screen
      .getByRole('slider', { name: 'Exposure' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(exposureRow)
    onScrubChange.mockClear()
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))
    expect(onScrubChange).toHaveBeenCalledWith(null)
  })

  it('switching between subpanels preserves each subpanel value (no cross-reset)', async () => {
    const bands = neutralBands()
    bands.orange = { hue: 8, saturation: 0, lightness: 0 }
    const tone = { ...TONE_NEUTRAL, userContrast: 22 }
    const color = { ...COLOR_NEUTRAL, userTint: -14 }
    renderPanel({ tone, color, selectiveColor: bands })

    // Tone sliders show the contrast value.
    expect(screen.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
      'aria-valuenow',
      '22',
    )

    // Switch to Color: tint value persists.
    await userEvent.click(screen.getByRole('tab', { name: /color/i }))
    expect(screen.getByRole('slider', { name: 'Tint' })).toHaveAttribute(
      'aria-valuenow',
      '-14',
    )

    // Switch to HSL and expand orange: hue=8 persists.
    await userEvent.click(
      screen.getByRole('tab', { name: enMessages['raw.adjust.hsl'] }),
    )
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.orange'] }),
    )
    expect(
      screen.getByRole('slider', { name: enMessages['raw.hsl.fields.hue'] }),
    ).toHaveAttribute('aria-valuenow', '8')

    // Back to Tone: contrast still 22.
    await userEvent.click(screen.getByRole('tab', { name: /^tone$/i }))
    expect(screen.getByRole('slider', { name: 'Contrast' })).toHaveAttribute(
      'aria-valuenow',
      '22',
    )
  })

  it('recedes the segment+reset row when scrubbing is true', () => {
    const { container, rerender } = render(
      <AdjustListPanel
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={neutralBands()}
        onToneChange={vi.fn()}
        onColorChange={vi.fn()}
        onSelectiveColorChange={vi.fn()}
        onToneReset={vi.fn()}
        onColorReset={vi.fn()}
        onSelectiveColorReset={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const chrome = container.querySelector('[data-adjust-section-chrome]')!
    expect(chrome).not.toHaveClass('opacity-0')

    rerender(
      <AdjustListPanel
        tone={TONE_NEUTRAL}
        color={COLOR_NEUTRAL}
        selectiveColor={neutralBands()}
        onToneChange={vi.fn()}
        onColorChange={vi.fn()}
        onSelectiveColorChange={vi.fn()}
        onToneReset={vi.fn()}
        onColorReset={vi.fn()}
        onSelectiveColorReset={vi.fn()}
        onScrubChange={vi.fn()}
        scrubbing
      />,
    )
    expect(chrome).toHaveClass('opacity-0')
    expect(
      container.querySelector('[role="region"][data-scrubbing="true"]'),
    ).toBeInTheDocument()
  })
})
