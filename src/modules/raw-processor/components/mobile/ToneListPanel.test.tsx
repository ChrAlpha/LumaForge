import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TONE_NEUTRAL } from '../tone-fields'
import { ToneListPanel } from './ToneListPanel'

describe('toneListPanel', () => {
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

  it('renders one slider per tone field in canonical order', () => {
    render(
      <ToneListPanel
        tone={{ ...TONE_NEUTRAL, userExposureEv: 1.25 }}
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const sliders = screen.getAllByRole('slider')
    expect(sliders).toHaveLength(6)
    expect(sliders.map((s) => s.getAttribute('aria-label'))).toEqual([
      'Exposure',
      'Contrast',
      'Highlights',
      'Shadows',
      'Whites',
      'Blacks',
    ])
    expect(screen.getByText('+1.25 EV')).toBeInTheDocument()
  })

  it('per-field reset emits a single-key patch', async () => {
    const onChange = vi.fn()
    render(
      <ToneListPanel
        tone={{ ...TONE_NEUTRAL, userContrast: 30 }}
        onChange={onChange}
        onScrubChange={vi.fn()}
      />,
    )
    await userEvent.click(
      screen.getByRole('button', { name: /reset contrast/i }),
    )
    expect(onChange).toHaveBeenCalledWith({ userContrast: 0 })
  })

  it('forwards scrub state with the originating field key', () => {
    const onScrubChange = vi.fn()
    render(
      <ToneListPanel
        tone={{ ...TONE_NEUTRAL, userShadows: 8 }}
        onChange={vi.fn()}
        onScrubChange={onScrubChange}
      />,
    )
    const shadowsRow = screen
      .getByRole('slider', { name: 'Shadows' })
      .closest('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(shadowsRow)
    expect(onScrubChange).toHaveBeenLastCalledWith({ key: 'userShadows' })
    fireEvent.pointerUp(shadowsRow)
    expect(onScrubChange).toHaveBeenLastCalledWith(null)
  })

  it('flags the active row and recedes siblings while a row is scrubbed', () => {
    const { container } = render(
      <ToneListPanel
        tone={TONE_NEUTRAL}
        onChange={vi.fn()}
        onScrubChange={vi.fn()}
      />,
    )
    const exposureScrub = container
      .querySelectorAll('[data-adjust-slider-row]')[0]
      .querySelector('[data-testid="adjust-slider-row-scrub"]')!
    fireEvent.pointerDown(exposureScrub)
    const rows = container.querySelectorAll('[data-adjust-slider-row]')
    expect(rows[0]).toHaveAttribute('data-active-scrub', 'true')
    expect(rows[0]).not.toHaveAttribute('data-sibling-scrubbing')
    for (const sibling of Array.from(rows).slice(1)) {
      expect(sibling).toHaveAttribute('data-sibling-scrubbing', 'true')
      expect(sibling).not.toHaveAttribute('data-active-scrub')
    }
    fireEvent.pointerUp(exposureScrub)
    for (const row of rows) {
      expect(row).not.toHaveAttribute('data-active-scrub')
      expect(row).not.toHaveAttribute('data-sibling-scrubbing')
    }
  })
})
