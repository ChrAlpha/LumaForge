import type { HSLBandId, HSLBandShift } from '@lumaforge/luma-color-runtime'
import { makeNeutralBand } from '@lumaforge/luma-color-runtime'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import enMessages from '~/locales/en.json'

import { HSL_BAND_ORDER } from '../fields/hsl-fields'
import type { HSLToolValue } from '../tools/HSLTool'
import { HSLListPanel } from './HSLListPanel'

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

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof HSLListPanel>> = {},
) {
  const props = {
    value: neutralBands() as HSLToolValue,
    onChange: vi.fn(),
    onScrubChange: vi.fn(),
    ...overrides,
  }
  render(<HSLListPanel {...props} />)
  return props
}

describe('hslListPanel', () => {
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

  it('renders 8 band rows in the documented red-to-magenta order', () => {
    renderPanel()
    const bandButtons = screen.getAllByRole('button', {
      name: (name) =>
        HSL_BAND_ORDER.some(
          (b) =>
            name ===
            enMessages[`raw.hsl.bands.${b}` as keyof typeof enMessages],
        ),
    })
    expect(bandButtons).toHaveLength(8)
    HSL_BAND_ORDER.forEach((band, index) => {
      const label =
        enMessages[`raw.hsl.bands.${band}` as keyof typeof enMessages]
      expect(bandButtons[index]).toHaveAccessibleName(label)
    })
  })

  it('keeps every band closed initially so no sliders are visible', () => {
    renderPanel()
    expect(screen.queryAllByRole('slider')).toHaveLength(0)
  })

  it('reveals the three focused slider rows when a band is tapped', async () => {
    renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.orange'] }),
    )
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(3)
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      enMessages['raw.hsl.fields.hue'],
      enMessages['raw.hsl.fields.saturation'],
      enMessages['raw.hsl.fields.lightness'],
    ])
  })

  it('closes the previously open band when a different band is tapped', async () => {
    renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.red'] }),
    )
    expect(screen.getAllByRole('slider')).toHaveLength(3)
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.blue'] }),
    )
    // Still 3 sliders — sliders belong to the new band, the old one collapsed.
    expect(screen.getAllByRole('slider')).toHaveLength(3)
  })

  it('clamps every slider to [-100, 100] with step 1', async () => {
    renderPanel()
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.red'] }),
    )
    for (const slider of screen.getAllByRole('slider')) {
      expect(slider).toHaveAttribute('aria-valuemin', '-100')
      expect(slider).toHaveAttribute('aria-valuemax', '100')
    }
  })

  it('onChange emits the band id and the touched scalar only', async () => {
    const user = userEvent.setup()
    const props = renderPanel()
    await user.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.red'] }),
    )
    const hueSlider = screen.getByRole('slider', {
      name: enMessages['raw.hsl.fields.hue'],
    })
    hueSlider.focus()
    await user.keyboard('{ArrowRight}')

    expect(props.onChange).toHaveBeenCalledTimes(1)
    expect(props.onChange).toHaveBeenCalledWith('red', { hue: 1 })
  })

  it('forwards scrub state with the originating band + key, never null at start', async () => {
    const onScrubChange = vi.fn()
    renderPanel({ onScrubChange })
    await userEvent.click(
      screen.getByRole('button', { name: enMessages['raw.hsl.bands.green'] }),
    )
    const sliders = screen.getAllByRole('slider')
    const hueRow = sliders[0].closest(
      '[data-testid="adjust-slider-row-scrub"]',
    )!
    fireEvent.pointerDown(hueRow)
    expect(onScrubChange).toHaveBeenLastCalledWith({
      band: 'green',
      key: 'hue',
    })
    fireEvent.pointerUp(hueRow)
    expect(onScrubChange).toHaveBeenLastCalledWith(null)
  })

  it('marks dirty bands with an indicator while leaving neutral bands unmarked', () => {
    const bands = neutralBands()
    bands.purple = { hue: 6, saturation: 0, lightness: 0 }
    renderPanel({ value: bands })
    const purpleRow = screen
      .getByRole('button', { name: enMessages['raw.hsl.bands.purple'] })
      .closest('[data-hsl-band-row]')!
    expect(purpleRow).toHaveAttribute('data-dirty', 'true')
    const redRow = screen
      .getByRole('button', { name: enMessages['raw.hsl.bands.red'] })
      .closest('[data-hsl-band-row]')!
    expect(redRow).not.toHaveAttribute('data-dirty')
  })
})
